-- Let Daily Target records use the employee's actual target hours (up to the
-- eight-hour workday) and store OT targets as hours instead of percentages.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter table public.daily_target_entries
  drop constraint daily_target_hours_fixed,
  drop constraint daily_target_rates_valid,
  add constraint daily_target_hours_valid check (
    target_hours > 0
    and target_hours <= 8
    and target_hours::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  add constraint daily_target_rates_valid check (
    hourly_target > 0
    and daily_target = pg_catalog.round(hourly_target * target_hours, 2)
    and target_percent between 0 and 100
    and target_amount = pg_catalog.round(daily_target * target_percent / 100, 2)
  );

-- The old OT value was a percentage of total OT hours. Convert it to an
-- equivalent hour quantity before replacing the generated amount formula so
-- historical payroll values remain unchanged.
drop view public.overtime_work_view;

alter table public.overtime_entries
  drop constraint overtime_target_values_valid,
  drop column target_amount,
  alter column target_percent type numeric(10,6)
    using target_percent::numeric(10,6);

update public.overtime_entries
set target_percent = pg_catalog.round(hours * target_percent / 100, 6);

alter table public.overtime_entries
  add column target_amount numeric(20,2)
    generated always as (pg_catalog.round(target_rate * target_percent, 2)) stored,
  add constraint overtime_target_hours_valid check (
    target_rate >= 0
    and target_percent >= 0
    and target_percent <= 24
    and target_percent::text not in ('NaN', 'Infinity', '-Infinity')
  );

create view public.overtime_work_view
with (security_invoker = true)
as
select
  ot.id,
  ot.reference_no,
  ot.employee_id,
  e.employee_no,
  e.name as employee_name,
  ot.work_date,
  ot.hours,
  ot.rate,
  ot.amount,
  ot.notes,
  ot.revision,
  ot.status,
  ot.replaces_id,
  ot.created_at,
  ot.updated_at,
  c.payroll_id as claimed_payroll_id,
  c.payroll_reference_no as claimed_payroll_reference,
  ot.company_id,
  ot.target_rate,
  ot.target_percent as target_hours,
  ot.target_amount
from public.overtime_entries ot
join public.employees e
  on e.id = ot.employee_id and e.company_id = ot.company_id
left join lateral (
  select poc.payroll_id, poc.payroll_reference_no
  from public.payroll_overtime_claims poc
  where poc.company_id = ot.company_id
    and poc.overtime_id = ot.id
    and poc.is_active
  order by poc.claimed_at desc, poc.id desc
  limit 1
) c on true;

revoke all on table public.overtime_work_view
from public, anon, authenticated;
grant select on table public.overtime_work_view to authenticated;

-- Preserve the existing dispatcher chain. This wrapper owns the two adjusted
-- payload contracts and delegates every unrelated operation unchanged.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_adjustable_target_hours;

create function private.perform_operation_v2(
  p_operation text,
  p_payload jsonb,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_payload jsonb := p_payload;
  v_company_id uuid := private.current_company_id();
  v_id uuid;
  v_employee_id uuid;
  v_reference text;
  v_date date;
  v_monthly_incentive numeric(20,2);
  v_target_hours numeric(5,2);
  v_hourly_target numeric(20,2);
  v_daily_target numeric(20,2);
  v_target_percent numeric(5,2);
  v_target_amount numeric(20,2);
  v_revision integer := 1;
  v_replaces_id uuid;
  v_daily_old public.daily_target_entries%rowtype;
begin
  if p_operation not in ('daily_target.upsert', 'overtime.upsert') then
    return private.perform_operation_before_adjustable_target_hours(
      p_operation,
      p_payload,
      p_actor
    );
  end if;

  if p_actor is null or p_actor <> (select auth.uid()) then
    raise exception using
      errcode = '42501',
      message = 'A valid authenticated actor is required';
  end if;
  if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
    raise exception using
      errcode = '42501',
      message = 'ERP operation guard is not active';
  end if;
  if v_company_id is null then
    raise exception using
      errcode = '42501',
      message = 'A company context is required';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Operation payload must be a JSON object';
  end if;

  if p_operation = 'overtime.upsert' then
    v_target_hours := pg_catalog.round((v_payload ->> 'target_hours')::numeric, 2);
    if v_target_hours < 0 or v_target_hours > 24
       or v_target_hours::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using
        errcode = '22023',
        message = 'OT Target Hours must be between 0 and 24';
    end if;

    -- The lower dispatcher still owns the auditable OT replacement workflow.
    -- Its legacy key now stores hours and the table formula applies the new
    -- hours-times-rate rule.
    v_payload := (v_payload - 'target_hours') || pg_catalog.jsonb_build_object(
      'target_percent',
      v_target_hours
    );
    return private.perform_operation_before_adjustable_target_hours(
      p_operation,
      v_payload,
      p_actor
    );
  end if;

  perform private.assert_permission('employees.write');
  v_employee_id := (v_payload ->> 'employee_id')::uuid;
  v_date := (v_payload ->> 'work_date')::date;
  v_target_hours := pg_catalog.round((v_payload ->> 'target_hours')::numeric, 2);
  v_target_percent := pg_catalog.round((v_payload ->> 'target_percent')::numeric, 2);

  if v_target_hours <= 0 or v_target_hours > 8
     or v_target_hours::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using
      errcode = '22023',
      message = 'Target Hours must be greater than 0 and no more than 8';
  end if;
  if v_target_percent < 0 or v_target_percent > 100
     or v_target_percent::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using
      errcode = '22023',
      message = 'Target percentage must be between 0 and 100';
  end if;

  select e.monthly_incentive
  into v_monthly_incentive
  from public.employees e
  where e.id = v_employee_id
    and e.company_id = v_company_id
    and e.status = 'active';
  if not found then
    raise exception using errcode = 'P0001', message = 'Active employee not found';
  end if;
  if v_monthly_incentive <= 0 then
    raise exception using
      errcode = '22023',
      message = 'Set a Monthly Incentive for this employee first';
  end if;

  if nullif(v_payload ->> 'id', '') is not null then
    v_id := (v_payload ->> 'id')::uuid;
    select *
    into v_daily_old
    from public.daily_target_entries dt
    where dt.id = v_id and dt.company_id = v_company_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Daily Target record not found';
    end if;
    if v_daily_old.status <> 'posted' then
      raise exception using
        errcode = 'P0001',
        message = 'Reversed Daily Target cannot be edited';
    end if;
    if exists (
      select 1
      from public.payroll_daily_target_claims c
      where c.daily_target_id = v_id and c.is_active
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'Claimed Daily Target cannot be edited';
    end if;

    update public.daily_target_entries
    set status = 'reversed',
        reversed_at = pg_catalog.clock_timestamp(),
        reversed_by = p_actor,
        reversal_reason = 'Replaced by corrected Daily Target',
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;

    v_replaces_id := v_id;
    v_revision := v_daily_old.revision + 1;
  end if;

  v_hourly_target := pg_catalog.round(v_monthly_incentive / 200, 2);
  v_daily_target := pg_catalog.round(v_hourly_target * v_target_hours, 2);
  v_target_amount := pg_catalog.round(v_daily_target * v_target_percent / 100, 2);
  v_id := pg_catalog.gen_random_uuid();
  v_reference := private.new_reference('DT');

  insert into public.daily_target_entries (
    id,
    company_id,
    reference_no,
    employee_id,
    work_date,
    target_hours,
    hourly_target,
    daily_target,
    target_percent,
    target_amount,
    notes,
    revision,
    replaces_id,
    created_by,
    updated_by
  ) values (
    v_id,
    v_company_id,
    v_reference,
    v_employee_id,
    v_date,
    v_target_hours,
    v_hourly_target,
    v_daily_target,
    v_target_percent,
    v_target_amount,
    nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 2000), ''),
    v_revision,
    v_replaces_id,
    p_actor,
    p_actor
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', p_operation,
    'id', v_id,
    'reference_no', v_reference,
    'idempotent', false
  );
end;
$function$;

revoke all on function
  private.perform_operation_before_adjustable_target_hours(text, jsonb, uuid),
  private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
