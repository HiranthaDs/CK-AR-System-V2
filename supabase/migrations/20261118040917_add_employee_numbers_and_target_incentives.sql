-- Add automatic CKP employee numbers and keep Daily Target incentive work
-- separate from standard overtime pay.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter table public.employees
  add column monthly_incentive numeric(20,2) not null default 0,
  add constraint employees_monthly_incentive_nonnegative check (
    monthly_incentive >= 0
    and monthly_incentive::text not in ('NaN', 'Infinity', '-Infinity')
  );

create table public.daily_target_entries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  reference_no text not null unique,
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  target_hours numeric(5,2) not null default 8,
  hourly_target numeric(20,2) not null,
  daily_target numeric(20,2) not null,
  target_percent numeric(5,2) not null,
  target_amount numeric(20,2) not null,
  notes text,
  revision integer not null default 1,
  status text not null default 'posted',
  replaces_id uuid references public.daily_target_entries(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint daily_target_reference_not_blank check (pg_catalog.btrim(reference_no) <> ''),
  constraint daily_target_hours_fixed check (target_hours = 8),
  constraint daily_target_rates_valid check (
    hourly_target > 0
    and daily_target = pg_catalog.round(hourly_target * 8, 2)
    and target_percent between 0 and 100
    and target_amount = pg_catalog.round(daily_target * target_percent / 100, 2)
  ),
  constraint daily_target_revision_positive check (revision > 0),
  constraint daily_target_status_valid check (status in ('posted', 'reversed')),
  constraint daily_target_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null)
    or (status = 'reversed' and reversed_at is not null and reversed_by is not null)
  )
);

create unique index daily_target_company_employee_date_posted_idx
  on public.daily_target_entries (company_id, employee_id, work_date)
  where status = 'posted';
create index daily_target_company_date_idx
  on public.daily_target_entries (company_id, work_date desc, id desc);
create index daily_target_replaces_idx
  on public.daily_target_entries (replaces_id);

create table public.payroll_daily_target_claims (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  payroll_id uuid not null references public.payrolls(id) on delete cascade,
  daily_target_id uuid not null references public.daily_target_entries(id) on delete cascade,
  payroll_reference_no text not null,
  is_active boolean not null default true,
  claimed_at timestamptz not null default pg_catalog.now(),
  released_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  released_by uuid references auth.users(id) on delete restrict,
  constraint payroll_daily_target_claim_release_state check (
    (is_active and released_at is null and released_by is null)
    or (not is_active and released_at is not null and released_by is not null)
  )
);

create unique index payroll_daily_target_active_idx
  on public.payroll_daily_target_claims (daily_target_id)
  where is_active;
create index payroll_daily_target_payroll_idx
  on public.payroll_daily_target_claims (company_id, payroll_id, is_active);

alter table public.overtime_entries
  add column target_rate numeric(20,2) not null default 0,
  add column target_percent numeric(5,2) not null default 0,
  add column target_amount numeric(20,2)
    generated always as (pg_catalog.round(hours * target_rate * target_percent / 100, 2)) stored,
  add constraint overtime_target_values_valid check (
    target_rate >= 0 and target_percent between 0 and 100
  );

create trigger daily_target_rpc_guard
before insert or update or delete on public.daily_target_entries
for each row execute function private.require_rpc_guard();

create trigger payroll_daily_target_claims_rpc_guard
before insert or update or delete on public.payroll_daily_target_claims
for each row execute function private.require_rpc_guard();

create trigger daily_target_company_context
before insert or update on public.daily_target_entries
for each row execute function private.enforce_company_context();

create trigger payroll_daily_target_claims_company_context
before insert or update on public.payroll_daily_target_claims
for each row execute function private.enforce_company_context();

create trigger daily_target_employee_company_parent
before insert or update on public.daily_target_entries
for each row execute function private.assert_company_parent('employee_id', 'employees', 'id');

create trigger payroll_daily_target_payroll_company_parent
before insert or update on public.payroll_daily_target_claims
for each row execute function private.assert_company_parent('payroll_id', 'payrolls', 'id');

create trigger payroll_daily_target_entry_company_parent
before insert or update on public.payroll_daily_target_claims
for each row execute function private.assert_company_parent('daily_target_id', 'daily_target_entries', 'id');

create trigger daily_target_finite_numbers
before insert or update on public.daily_target_entries
for each row execute function private.reject_non_finite_columns(
  'target_hours', 'hourly_target', 'daily_target', 'target_percent', 'target_amount'
);

create trigger overtime_target_finite_numbers
before insert or update on public.overtime_entries
for each row execute function private.reject_non_finite_columns('target_rate', 'target_percent');

alter table public.daily_target_entries enable row level security;
alter table public.payroll_daily_target_claims enable row level security;

create policy erp_read on public.daily_target_entries
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['employees.read', 'payroll.read', 'production.read', 'reports.read']::text[]
));

create policy erp_read on public.payroll_daily_target_claims
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['payroll.read', 'reports.read', 'dashboard.read', 'finance.read']::text[]
));

revoke all on table public.daily_target_entries, public.payroll_daily_target_claims
from public, anon, authenticated;
grant select on table public.daily_target_entries, public.payroll_daily_target_claims
to authenticated;

create view public.daily_target_work_view
with (security_invoker = true)
as
select
  dt.id,
  dt.reference_no,
  dt.employee_id,
  e.employee_no,
  e.name as employee_name,
  dt.work_date,
  dt.target_hours,
  dt.hourly_target,
  dt.daily_target,
  dt.target_percent,
  dt.target_amount,
  dt.notes,
  dt.revision,
  dt.status,
  dt.replaces_id,
  dt.created_at,
  dt.updated_at,
  c.payroll_id as claimed_payroll_id,
  c.payroll_reference_no as claimed_payroll_reference,
  dt.company_id
from public.daily_target_entries dt
join public.employees e
  on e.id = dt.employee_id and e.company_id = dt.company_id
left join lateral (
  select pdtc.payroll_id, pdtc.payroll_reference_no
  from public.payroll_daily_target_claims pdtc
  where pdtc.company_id = dt.company_id
    and pdtc.daily_target_id = dt.id
    and pdtc.is_active
  order by pdtc.claimed_at desc, pdtc.id desc
  limit 1
) c on true;

create or replace view public.overtime_work_view
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
  ot.target_percent,
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

revoke all on table public.daily_target_work_view, public.overtime_work_view
from public, anon, authenticated;
grant select on table public.daily_target_work_view, public.overtime_work_view
to authenticated;

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_target_incentives;

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
  v_result jsonb;
  v_company_id uuid := private.current_company_id();
  v_id uuid;
  v_target_id uuid;
  v_reference text;
  v_employee_no text;
  v_reason text;
  v_date date;
  v_salary_month text;
  v_month_start date;
  v_month_end date;
  v_monthly_incentive numeric(20,2);
  v_hourly_target numeric(20,2);
  v_daily_target numeric(20,2);
  v_target_percent numeric(5,2);
  v_target_amount numeric(20,2);
  v_ot_rate numeric(20,2);
  v_revision integer := 1;
  v_replaces_id uuid;
  v_daily_old public.daily_target_entries%rowtype;
  v_daily_ids uuid[] := array[]::uuid[];
  v_ot_ids uuid[] := array[]::uuid[];
  v_input jsonb;
  v_target_earnings jsonb := '[]'::jsonb;
  v_ot_target_earnings jsonb := '[]'::jsonb;
  v_count integer;
begin
  if p_operation in (
    'employee.upsert', 'daily_target.upsert', 'daily_target.reverse',
    'overtime.upsert', 'payroll.post', 'payroll.reverse'
  ) then
    if p_actor is null or p_actor <> (select auth.uid()) then
      raise exception using errcode = '42501', message = 'A valid authenticated actor is required';
    end if;
    if coalesce(pg_catalog.current_setting('app.erp_rpc_guard', true), '') <> 'enabled' then
      raise exception using errcode = '42501', message = 'ERP operation guard is not active';
    end if;
    if v_company_id is null then
      raise exception using errcode = '42501', message = 'A company context is required';
    end if;
    if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
      raise exception using errcode = '22023', message = 'Operation payload must be a JSON object';
    end if;
  end if;

  if p_operation = 'employee.upsert' then
    perform private.assert_permission('employees.write');
    v_monthly_incentive := pg_catalog.round(
      coalesce(nullif(v_payload ->> 'monthly_incentive', '')::numeric, 0), 2
    );
    if v_monthly_incentive < 0
       or v_monthly_incentive::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '22023', message = 'Monthly incentive must be zero or greater';
    end if;

    if nullif(v_payload ->> 'id', '') is null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('ckp-employee-number', 0)
      );
      select 'CKP ' || pg_catalog.lpad(
        (coalesce(pg_catalog.max(
          nullif(pg_catalog.substring(e.employee_no, '^CKP ([0-9]+)$'), '')::integer
        ), 0) + 1)::text,
        3,
        '0'
      )
      into v_employee_no
      from public.employees e;
    else
      select e.employee_no into v_employee_no
      from public.employees e
      where e.id = (v_payload ->> 'id')::uuid
        and e.company_id = v_company_id;
      if v_employee_no is null then
        raise exception using errcode = 'P0001', message = 'Employee not found';
      end if;
    end if;

    v_payload := pg_catalog.jsonb_set(
      v_payload, '{employee_no}', pg_catalog.to_jsonb(v_employee_no), true
    );
    v_result := private.perform_operation_before_target_incentives(
      p_operation, v_payload, p_actor
    );
    v_id := (v_result ->> 'id')::uuid;
    update public.employees
    set monthly_incentive = v_monthly_incentive,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id;
    return v_result || pg_catalog.jsonb_build_object('reference_no', v_employee_no);

  elsif p_operation = 'daily_target.upsert' then
    perform private.assert_permission('employees.write');
    v_target_id := (v_payload ->> 'employee_id')::uuid;
    v_date := (v_payload ->> 'work_date')::date;
    v_target_percent := pg_catalog.round((v_payload ->> 'target_percent')::numeric, 2);
    if v_target_percent < 0 or v_target_percent > 100
       or v_target_percent::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '22023', message = 'Target percentage must be between 0 and 100';
    end if;

    select e.monthly_incentive into v_monthly_incentive
    from public.employees e
    where e.id = v_target_id
      and e.company_id = v_company_id
      and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active employee not found';
    end if;
    if v_monthly_incentive <= 0 then
      raise exception using errcode = '22023', message = 'Set a Monthly Incentive for this employee first';
    end if;

    if nullif(v_payload ->> 'id', '') is not null then
      v_id := (v_payload ->> 'id')::uuid;
      select * into v_daily_old
      from public.daily_target_entries dt
      where dt.id = v_id and dt.company_id = v_company_id
      for update;
      if not found then
        raise exception using errcode = 'P0001', message = 'Daily Target record not found';
      end if;
      if v_daily_old.status <> 'posted' then
        raise exception using errcode = 'P0001', message = 'Reversed Daily Target cannot be edited';
      end if;
      if exists (
        select 1 from public.payroll_daily_target_claims c
        where c.daily_target_id = v_id and c.is_active
      ) then
        raise exception using errcode = 'P0001', message = 'Claimed Daily Target cannot be edited';
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
    v_daily_target := pg_catalog.round(v_hourly_target * 8, 2);
    v_target_amount := pg_catalog.round(v_daily_target * v_target_percent / 100, 2);
    v_id := pg_catalog.gen_random_uuid();
    v_reference := private.new_reference('DT');

    insert into public.daily_target_entries (
      id, company_id, reference_no, employee_id, work_date, target_hours,
      hourly_target, daily_target, target_percent, target_amount, notes,
      revision, replaces_id, created_by, updated_by
    ) values (
      v_id, v_company_id, v_reference, v_target_id, v_date, 8,
      v_hourly_target, v_daily_target, v_target_percent, v_target_amount,
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 2000), ''),
      v_revision, v_replaces_id, p_actor, p_actor
    );

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'daily_target.reverse' then
    perform private.assert_permission('employees.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_daily_old
    from public.daily_target_entries dt
    where dt.id = v_id and dt.company_id = v_company_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Daily Target record not found';
    end if;
    if v_daily_old.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Daily Target is already reversed';
    end if;
    if exists (
      select 1 from public.payroll_daily_target_claims c
      where c.daily_target_id = v_id and c.is_active
    ) then
      raise exception using errcode = 'P0001', message = 'Claimed Daily Target cannot be reversed';
    end if;
    v_reason := coalesce(
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'reason'), 500), ''),
      'Daily Target reversed'
    );
    update public.daily_target_entries
    set status = 'reversed',
        reversed_at = pg_catalog.clock_timestamp(),
        reversed_by = p_actor,
        reversal_reason = v_reason,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_daily_old.reference_no,
      'idempotent', false, 'reversed', true
    );

  elsif p_operation = 'overtime.upsert' then
    perform private.assert_permission('employees.write');
    v_target_id := (v_payload ->> 'employee_id')::uuid;
    v_date := (v_payload ->> 'work_date')::date;
    v_target_percent := pg_catalog.round((v_payload ->> 'target_percent')::numeric, 2);
    if v_target_percent < 0 or v_target_percent > 100
       or v_target_percent::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '22023', message = 'OT Target percentage must be between 0 and 100';
    end if;

    select e.ot_rate, e.monthly_incentive
    into v_ot_rate, v_monthly_incentive
    from public.employees e
    where e.id = v_target_id
      and e.company_id = v_company_id
      and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active employee not found';
    end if;
    if v_ot_rate <= 0 then
      raise exception using errcode = '22023', message = 'Set the employee OT Rate first';
    end if;
    if v_monthly_incentive <= 0 then
      raise exception using errcode = '22023', message = 'Set the employee Monthly Incentive first';
    end if;
    if not exists (
      select 1
      from public.daily_target_entries dt
      where dt.company_id = v_company_id
        and dt.employee_id = v_target_id
        and dt.work_date = v_date
        and dt.status = 'posted'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Record the completed 8-hour Daily Target before adding OT for this date';
    end if;

    v_payload := pg_catalog.jsonb_set(
      v_payload, '{rate}', pg_catalog.to_jsonb(v_ot_rate), true
    );
    v_result := private.perform_operation_before_target_incentives(
      p_operation, v_payload, p_actor
    );
    v_id := (v_result ->> 'id')::uuid;
    update public.overtime_entries
    set target_rate = pg_catalog.round(v_monthly_incentive / 200, 2),
        target_percent = v_target_percent,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id;
    return v_result;

  elsif p_operation = 'payroll.post' then
    perform private.assert_permission('payroll.write');
    v_target_id := (v_payload ->> 'employee_id')::uuid;
    v_salary_month := v_payload ->> 'salary_month';
    if coalesce(v_salary_month, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception using errcode = '22023', message = 'salary_month must use YYYY-MM';
    end if;
    v_month_start := pg_catalog.to_date(v_salary_month || '-01', 'YYYY-MM-DD');
    v_month_end := (v_month_start + interval '1 month')::date;

    v_input := coalesce(v_payload -> 'daily_target_ids', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 500 then
      raise exception using errcode = '22023', message = 'daily_target_ids must be an array of at most 500 IDs';
    end if;
    select coalesce(
      pg_catalog.array_agg(distinct x.value::uuid order by x.value::uuid),
      array[]::uuid[]
    )
    into v_daily_ids
    from pg_catalog.jsonb_array_elements_text(v_input) x(value);
    if pg_catalog.cardinality(v_daily_ids) <> pg_catalog.jsonb_array_length(v_input) then
      raise exception using errcode = '22023', message = 'daily_target_ids must be unique';
    end if;

    if pg_catalog.cardinality(v_daily_ids) > 0 then
      perform dt.id
      from public.daily_target_entries dt
      where dt.id = any(v_daily_ids)
      order by dt.id
      for update;

      select pg_catalog.count(*)::integer into v_count
      from public.daily_target_entries dt
      where dt.id = any(v_daily_ids)
        and dt.company_id = v_company_id
        and dt.employee_id = v_target_id
        and dt.status = 'posted'
        and dt.work_date >= v_month_start
        and dt.work_date < v_month_end
        and not exists (
          select 1 from public.payroll_daily_target_claims c
          where c.daily_target_id = dt.id and c.is_active
        );
      if v_count <> pg_catalog.cardinality(v_daily_ids) then
        raise exception using
          errcode = '23505',
          message = 'One or more Daily Target claims are invalid, outside the salary month, or already claimed';
      end if;

      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'type', 'daily_target_incentive',
          'description', 'Daily Target ' || dt.reference_no || ' · ' || pg_catalog.to_char(dt.work_date, 'YYYY-MM-DD'),
          'quantity', dt.target_percent,
          'rate', dt.daily_target,
          'amount', dt.target_amount,
          'account_code', 'WAGES_EXPENSE'
        ) order by dt.work_date, dt.id
      ), '[]'::jsonb)
      into v_target_earnings
      from public.daily_target_entries dt
      where dt.id = any(v_daily_ids) and dt.target_amount > 0;
    end if;

    v_input := coalesce(v_payload -> 'overtime_ids', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) > 500 then
      raise exception using errcode = '22023', message = 'overtime_ids must be an array of at most 500 IDs';
    end if;
    select coalesce(
      pg_catalog.array_agg(distinct x.value::uuid order by x.value::uuid),
      array[]::uuid[]
    )
    into v_ot_ids
    from pg_catalog.jsonb_array_elements_text(v_input) x(value);

    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'type', 'overtime_target_allowance',
        'description', 'OT Target ' || ot.reference_no || ' · ' || pg_catalog.to_char(ot.work_date, 'YYYY-MM-DD'),
        'quantity', ot.hours,
        'rate', ot.target_rate,
        'amount', ot.target_amount,
        'account_code', 'WAGES_EXPENSE'
      ) order by ot.work_date, ot.id
    ), '[]'::jsonb)
    into v_ot_target_earnings
    from public.overtime_entries ot
    where ot.id = any(v_ot_ids)
      and ot.company_id = v_company_id
      and ot.employee_id = v_target_id
      and ot.work_date >= v_month_start
      and ot.work_date < v_month_end
      and ot.status = 'posted'
      and ot.target_amount > 0;

    if pg_catalog.jsonb_typeof(coalesce(v_payload -> 'earnings', '[]'::jsonb)) <> 'array' then
      raise exception using errcode = '22023', message = 'earnings must be an array';
    end if;
    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{earnings}',
      coalesce(v_payload -> 'earnings', '[]'::jsonb)
        || v_target_earnings
        || v_ot_target_earnings,
      true
    );

    v_result := private.perform_operation_before_target_incentives(
      p_operation, v_payload, p_actor
    );
    v_id := (v_result ->> 'id')::uuid;

    insert into public.payroll_daily_target_claims (
      company_id, payroll_id, daily_target_id, payroll_reference_no, created_by
    )
    select
      v_company_id, v_id, dt.id,
      coalesce(v_result ->> 'reference_no', v_id::text), p_actor
    from public.daily_target_entries dt
    where dt.id = any(v_daily_ids)
    order by dt.id;
    return v_result;

  elsif p_operation = 'payroll.reverse' then
    v_result := private.perform_operation_before_target_incentives(
      p_operation, v_payload, p_actor
    );
    v_id := (v_payload ->> 'id')::uuid;
    update public.payroll_daily_target_claims
    set is_active = false,
        released_at = pg_catalog.clock_timestamp(),
        released_by = p_actor
    where company_id = v_company_id
      and payroll_id = v_id
      and is_active;
    return v_result;
  end if;

  return private.perform_operation_before_target_incentives(
    p_operation, p_payload, p_actor
  );
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
