-- Complete the staff workflow with employee profiles, attendance-backed Daily
-- Targets, centrally configured shift times, automatic OT, and dated salary
-- advances that are claimed by payroll in their own salary month.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

-- Employee profile data is kept on the existing employee master so historical
-- payroll and work foreign keys remain untouched.
alter table public.employees
  add column profile_picture_path text,
  add column education_qualifications text,
  add column other_qualifications text,
  add column profile_notes text,
  add constraint employees_profile_picture_path_valid check (
    profile_picture_path is null
    or (
      pg_catalog.char_length(profile_picture_path) <= 500
      and profile_picture_path ~ '^[0-9a-f-]{36}/employees/[0-9a-f-]{36}\.(jpg|png|webp)$'
    )
  ),
  add constraint employees_profile_text_lengths_valid check (
    pg_catalog.char_length(coalesce(education_qualifications, '')) <= 4000
    and pg_catalog.char_length(coalesce(other_qualifications, '')) <= 4000
    and pg_catalog.char_length(coalesce(profile_notes, '')) <= 4000
  );

-- Each company owns one shift definition. Calculations read this row instead
-- of embedding clock times in forms or database operations.
create table public.company_shift_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  day_start time without time zone not null default '08:30',
  day_end time without time zone not null default '17:30',
  night_start time without time zone not null default '17:30',
  night_end time without time zone not null default '08:30',
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint company_shift_settings_day_valid check (day_start <> day_end),
  constraint company_shift_settings_night_valid check (night_start <> night_end),
  constraint company_shift_settings_contiguous check (
    day_end = night_start and night_end = day_start
  )
);

insert into public.company_shift_settings (company_id)
select c.id from public.companies c
on conflict (company_id) do nothing;

create trigger company_shift_settings_rpc_guard
before insert or update or delete on public.company_shift_settings
for each row execute function private.require_rpc_guard();

create trigger company_shift_settings_company_context
before insert or update on public.company_shift_settings
for each row execute function private.enforce_company_context();

alter table public.company_shift_settings enable row level security;
create policy erp_read on public.company_shift_settings
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['employees.read', 'employees.write', 'payroll.read', 'payroll.write']::text[]
));
revoke all on table public.company_shift_settings from public, anon, authenticated;
grant select on table public.company_shift_settings to authenticated;

-- Attendance remains part of the existing Daily Target record. Existing rows
-- are retained as legacy present records; new writes require explicit times or
-- an absent/no-pay selection.
drop view public.daily_target_work_view;

alter table public.daily_target_entries
  drop constraint daily_target_hours_valid,
  drop constraint daily_target_rates_valid,
  add column is_absent boolean not null default false,
  add column in_time time without time zone,
  add column out_time time without time zone,
  add column total_hours numeric(6,2) not null default 0,
  add column day_hours numeric(6,2) not null default 0,
  add column night_ot_hours numeric(6,2) not null default 0,
  add column activity text,
  add constraint daily_target_hours_valid check (
    target_hours >= 0
    and target_hours <= 8
    and target_hours::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  add constraint daily_target_rates_valid check (
    hourly_target >= 0
    and ((is_absent and hourly_target = 0) or (not is_absent and hourly_target > 0))
    and daily_target = pg_catalog.round(hourly_target * target_hours, 2)
    and target_percent between 0 and 100
    and target_amount = pg_catalog.round(daily_target * target_percent / 100, 2)
  ),
  add constraint daily_target_attendance_valid check (
    total_hours >= 0 and day_hours >= 0 and night_ot_hours >= 0
    and total_hours::text not in ('NaN', 'Infinity', '-Infinity')
    and day_hours::text not in ('NaN', 'Infinity', '-Infinity')
    and night_ot_hours::text not in ('NaN', 'Infinity', '-Infinity')
    and (
      (
        is_absent
        and in_time is null and out_time is null
        and target_hours = 0 and target_percent = 0
        and total_hours = 0 and day_hours = 0 and night_ot_hours = 0
        and daily_target = 0 and target_amount = 0
      )
      or (
        not is_absent
        and target_hours > 0
        and (
          (in_time is null and out_time is null) -- preserved legacy records
          or (in_time is not null and out_time is not null and total_hours > 0)
        )
      )
    )
  ),
  add constraint daily_target_activity_length_valid check (
    pg_catalog.char_length(coalesce(activity, '')) <= 2000
  );

create or replace view public.daily_target_work_view
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
  dt.is_absent,
  dt.in_time,
  dt.out_time,
  dt.total_hours,
  dt.day_hours,
  dt.night_ot_hours,
  dt.activity,
  dt.notes,
  dt.revision,
  dt.status,
  dt.replaces_id,
  dt.created_at,
  dt.updated_at,
  c.payroll_id as claimed_payroll_id,
  c.payroll_reference_no as claimed_payroll_reference,
  dt.company_id,
  (
    not dt.is_absent
    and dt.in_time is not null
    and dt.in_time > css.day_start
  ) as is_late
from public.daily_target_entries dt
join public.employees e
  on e.id = dt.employee_id and e.company_id = dt.company_id
join public.company_shift_settings css
  on css.company_id = dt.company_id
left join lateral (
  select pdtc.payroll_id, pdtc.payroll_reference_no
  from public.payroll_daily_target_claims pdtc
  where pdtc.company_id = dt.company_id
    and pdtc.daily_target_id = dt.id
    and pdtc.is_active
  order by pdtc.claimed_at desc, pdtc.id desc
  limit 1
) c on true;

revoke all on table public.daily_target_work_view from public, anon, authenticated;
grant select on table public.daily_target_work_view to authenticated;

-- Advances are append-only business records. Payroll claims are separate so a
-- payroll reversal can release an advance without rewriting its original date
-- or amount.
create table public.employee_salary_advances (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  reference_no text not null unique,
  employee_id uuid not null references public.employees(id) on delete restrict,
  advance_date date not null,
  amount numeric(20,2) not null,
  notes text,
  status text not null default 'posted',
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint employee_salary_advances_reference_not_blank check (pg_catalog.btrim(reference_no) <> ''),
  constraint employee_salary_advances_amount_positive check (
    amount > 0 and amount::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint employee_salary_advances_notes_length check (pg_catalog.char_length(coalesce(notes, '')) <= 1000),
  constraint employee_salary_advances_status_valid check (status in ('posted', 'reversed')),
  constraint employee_salary_advances_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null)
    or (status = 'reversed' and reversed_at is not null and reversed_by is not null)
  )
);

create table public.payroll_salary_advance_claims (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  payroll_id uuid not null references public.payrolls(id) on delete cascade,
  salary_advance_id uuid not null references public.employee_salary_advances(id) on delete restrict,
  payroll_reference_no text not null,
  is_active boolean not null default true,
  claimed_at timestamptz not null default pg_catalog.now(),
  released_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  released_by uuid references auth.users(id) on delete restrict,
  constraint payroll_salary_advance_claim_release_state check (
    (is_active and released_at is null and released_by is null)
    or (not is_active and released_at is not null and released_by is not null)
  )
);

create unique index payroll_salary_advance_active_idx
  on public.payroll_salary_advance_claims (salary_advance_id)
  where is_active;
create index employee_salary_advances_company_employee_date_idx
  on public.employee_salary_advances (company_id, employee_id, advance_date desc, id desc)
  where status = 'posted';
create index payroll_salary_advance_payroll_idx
  on public.payroll_salary_advance_claims (company_id, payroll_id, is_active);

create trigger employee_salary_advances_rpc_guard
before insert or update or delete on public.employee_salary_advances
for each row execute function private.require_rpc_guard();
create trigger payroll_salary_advance_claims_rpc_guard
before insert or update or delete on public.payroll_salary_advance_claims
for each row execute function private.require_rpc_guard();
create trigger employee_salary_advances_company_context
before insert or update on public.employee_salary_advances
for each row execute function private.enforce_company_context();
create trigger payroll_salary_advance_claims_company_context
before insert or update on public.payroll_salary_advance_claims
for each row execute function private.enforce_company_context();
create trigger employee_salary_advances_employee_parent
before insert or update on public.employee_salary_advances
for each row execute function private.assert_company_parent('employee_id', 'employees', 'id');
create trigger payroll_salary_advance_claims_payroll_parent
before insert or update on public.payroll_salary_advance_claims
for each row execute function private.assert_company_parent('payroll_id', 'payrolls', 'id');
create trigger payroll_salary_advance_claims_advance_parent
before insert or update on public.payroll_salary_advance_claims
for each row execute function private.assert_company_parent('salary_advance_id', 'employee_salary_advances', 'id');
create trigger employee_salary_advances_finite_numbers
before insert or update on public.employee_salary_advances
for each row execute function private.reject_non_finite_columns('amount');

alter table public.employee_salary_advances enable row level security;
alter table public.payroll_salary_advance_claims enable row level security;
create policy erp_read on public.employee_salary_advances
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['employees.read', 'employees.write', 'payroll.read', 'payroll.write', 'reports.read']::text[]
));
create policy erp_read on public.payroll_salary_advance_claims
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['payroll.read', 'payroll.write', 'reports.read']::text[]
));
revoke all on table public.employee_salary_advances, public.payroll_salary_advance_claims
from public, anon, authenticated;
grant select on table public.employee_salary_advances, public.payroll_salary_advance_claims
to authenticated;

create view public.employee_salary_advance_view
with (security_invoker = true)
as
select
  a.id,
  a.reference_no,
  a.employee_id,
  e.employee_no,
  e.name as employee_name,
  a.advance_date,
  a.amount,
  a.notes,
  a.status,
  a.reversed_at,
  a.reversal_reason,
  a.created_at,
  c.payroll_id as claimed_payroll_id,
  c.payroll_reference_no as claimed_payroll_reference,
  a.company_id
from public.employee_salary_advances a
join public.employees e
  on e.id = a.employee_id and e.company_id = a.company_id
left join lateral (
  select psac.payroll_id, psac.payroll_reference_no
  from public.payroll_salary_advance_claims psac
  where psac.salary_advance_id = a.id and psac.is_active
  order by psac.claimed_at desc, psac.id desc
  limit 1
) c on true;

revoke all on table public.employee_salary_advance_view from public, anon, authenticated;
grant select on table public.employee_salary_advance_view to authenticated;

-- Employee photographs are private files. Authenticated staff require employee
-- permissions to read or modify them; paths are unguessable UUID filenames.
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'employee-profile-images',
  'employee-profile-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists employee_profile_images_insert on storage.objects;
create policy employee_profile_images_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'employee-profile-images'
  and private.has_company_permission(
    ((storage.foldername(name))[1])::uuid,
    'employees.write'
  )
);
drop policy if exists employee_profile_images_select on storage.objects;
create policy employee_profile_images_select on storage.objects
for select to authenticated
using (
  bucket_id = 'employee-profile-images'
  and private.has_company_permission(
    ((storage.foldername(name))[1])::uuid,
    'employees.read'
  )
);
drop policy if exists employee_profile_images_update on storage.objects;
create policy employee_profile_images_update on storage.objects
for update to authenticated
using (
  bucket_id = 'employee-profile-images'
  and private.has_company_permission(
    ((storage.foldername(name))[1])::uuid,
    'employees.write'
  )
)
with check (
  bucket_id = 'employee-profile-images'
  and private.has_company_permission(
    ((storage.foldername(name))[1])::uuid,
    'employees.write'
  )
);
drop policy if exists employee_profile_images_delete on storage.objects;
create policy employee_profile_images_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'employee-profile-images'
  and private.has_company_permission(
    ((storage.foldername(name))[1])::uuid,
    'employees.write'
  )
);

-- Preserve every existing dispatcher layer and own only the new contracts.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_staff_workflow;

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
  v_employee_id uuid;
  v_reference text;
  v_date date;
  v_salary_month text;
  v_month_start date;
  v_month_end date;
  v_monthly_incentive numeric(20,2);
  v_target_hours numeric(5,2);
  v_hourly_target numeric(20,2);
  v_daily_target numeric(20,2);
  v_target_percent numeric(5,2);
  v_target_amount numeric(20,2);
  v_is_absent boolean;
  v_in_time time without time zone;
  v_out_time time without time zone;
  v_day_start time without time zone;
  v_day_end time without time zone;
  v_night_start time without time zone;
  v_night_end time without time zone;
  v_in_ts timestamp;
  v_out_ts timestamp;
  v_day_start_ts timestamp;
  v_day_end_ts timestamp;
  v_night_start_ts timestamp;
  v_night_end_ts timestamp;
  v_total_hours numeric(6,2) := 0;
  v_day_hours numeric(6,2) := 0;
  v_night_ot_hours numeric(6,2) := 0;
  v_revision integer := 1;
  v_replaces_id uuid;
  v_daily_old public.daily_target_entries%rowtype;
  v_advance_old public.employee_salary_advances%rowtype;
  v_advance_ids uuid[] := array[]::uuid[];
  v_manual_deductions jsonb := '[]'::jsonb;
  v_advance_deductions jsonb := '[]'::jsonb;
  v_profile_path text;
  v_education text;
  v_other_qualifications text;
  v_profile_notes text;
begin
  if p_operation not in (
    'employee.upsert', 'daily_target.upsert', 'overtime.upsert',
    'shift_settings.upsert', 'salary_advance.upsert', 'salary_advance.reverse',
    'payroll.post', 'payroll.reverse', 'system.purge_business_data'
  ) then
    return private.perform_operation_before_staff_workflow(p_operation, p_payload, p_actor);
  end if;

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

  if p_operation = 'system.purge_business_data' then
    delete from public.payroll_salary_advance_claims where company_id = v_company_id;
    delete from public.employee_salary_advances where company_id = v_company_id;
    return private.perform_operation_before_staff_workflow(p_operation, p_payload, p_actor);

  elsif p_operation = 'employee.upsert' then
    perform private.assert_permission('employees.write');
    v_profile_path := nullif(pg_catalog.btrim(v_payload ->> 'profile_picture_path'), '');
    v_education := nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'education_qualifications'), 4000), '');
    v_other_qualifications := nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'other_qualifications'), 4000), '');
    v_profile_notes := nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'profile_notes'), 4000), '');
    if v_profile_path is not null and (
      pg_catalog.char_length(v_profile_path) > 500
      or v_profile_path not like (v_company_id::text || '/employees/%')
      or v_profile_path !~ '^[0-9a-f-]{36}/employees/[0-9a-f-]{36}\.(jpg|png|webp)$'
    ) then
      raise exception using errcode = '22023', message = 'Employee profile picture path is invalid';
    end if;
    v_result := private.perform_operation_before_staff_workflow(p_operation, v_payload, p_actor);
    v_id := (v_result ->> 'id')::uuid;
    update public.employees
    set profile_picture_path = v_profile_path,
        education_qualifications = v_education,
        other_qualifications = v_other_qualifications,
        profile_notes = v_profile_notes,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id;
    return v_result;

  elsif p_operation = 'shift_settings.upsert' then
    perform private.assert_permission('employees.write');
    v_day_start := (v_payload ->> 'day_start')::time;
    v_day_end := (v_payload ->> 'day_end')::time;
    v_night_start := (v_payload ->> 'night_start')::time;
    v_night_end := (v_payload ->> 'night_end')::time;
    if v_day_start = v_day_end or v_night_start = v_night_end then
      raise exception using errcode = '22023', message = 'Shift start and end times must be different';
    end if;
    if v_day_end <> v_night_start then
      raise exception using errcode = '22023', message = 'Night shift must start when the day shift ends';
    end if;
    if v_night_end <> v_day_start then
      raise exception using errcode = '22023', message = 'Night shift must end when the next day shift starts';
    end if;
    insert into public.company_shift_settings (
      company_id, day_start, day_end, night_start, night_end, updated_by
    ) values (
      v_company_id, v_day_start, v_day_end, v_night_start, v_night_end, p_actor
    )
    on conflict (company_id) do update
    set day_start = excluded.day_start,
        day_end = excluded.day_end,
        night_start = excluded.night_start,
        night_end = excluded.night_end,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_company_id,
      'reference_no', null, 'idempotent', false
    );

  elsif p_operation = 'daily_target.upsert' then
    perform private.assert_permission('employees.write');
    v_employee_id := (v_payload ->> 'employee_id')::uuid;
    v_date := (v_payload ->> 'work_date')::date;
    v_is_absent := coalesce((v_payload ->> 'is_absent')::boolean, false);

    insert into public.company_shift_settings (company_id, updated_by)
    values (v_company_id, p_actor)
    on conflict (company_id) do nothing;

    select e.monthly_incentive
    into v_monthly_incentive
    from public.employees e
    where e.id = v_employee_id
      and e.company_id = v_company_id
      and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active employee not found';
    end if;

    select css.day_start, css.day_end, css.night_start, css.night_end
    into v_day_start, v_day_end, v_night_start, v_night_end
    from public.company_shift_settings css
    where css.company_id = v_company_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'Shift & OT Settings are missing';
    end if;

    if v_is_absent then
      v_target_hours := 0;
      v_target_percent := 0;
    else
      if v_monthly_incentive <= 0 then
        raise exception using errcode = '22023', message = 'Set a Monthly Incentive for this employee first';
      end if;
      v_in_time := (v_payload ->> 'in_time')::time;
      v_out_time := (v_payload ->> 'out_time')::time;
      v_target_hours := pg_catalog.round((v_payload ->> 'target_hours')::numeric, 2);
      v_target_percent := pg_catalog.round((v_payload ->> 'target_percent')::numeric, 2);
      if v_target_hours <= 0 or v_target_hours > 8
         or v_target_hours::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception using errcode = '22023', message = 'Target Hours must be greater than 0 and no more than 8';
      end if;
      if v_target_percent < 0 or v_target_percent > 100
         or v_target_percent::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception using errcode = '22023', message = 'Target percentage must be between 0 and 100';
      end if;

      v_in_ts := v_date + v_in_time;
      v_out_ts := v_date + v_out_time;
      if v_out_ts <= v_in_ts then v_out_ts := v_out_ts + interval '1 day'; end if;
      v_day_start_ts := v_date + v_day_start;
      v_day_end_ts := v_date + v_day_end;
      if v_day_end_ts <= v_day_start_ts then v_day_end_ts := v_day_end_ts + interval '1 day'; end if;
      v_night_start_ts := v_date + v_night_start;
      v_night_end_ts := v_date + v_night_end;
      if v_night_end_ts <= v_night_start_ts then v_night_end_ts := v_night_end_ts + interval '1 day'; end if;

      v_total_hours := pg_catalog.round((extract(epoch from (v_out_ts - v_in_ts)) / 3600)::numeric, 2);
      v_day_hours := pg_catalog.round(least(
        8::numeric,
        greatest(
          0::numeric,
          (extract(epoch from (
            least(v_out_ts, v_day_end_ts) - greatest(v_in_ts, v_day_start_ts)
          )) / 3600)::numeric
        )
      ), 2);
      v_night_ot_hours := pg_catalog.round(greatest(
        0::numeric,
        (extract(epoch from (
          least(v_out_ts, v_night_end_ts) - greatest(v_in_ts, v_night_start_ts)
        )) / 3600)::numeric
      ), 2);
      if v_target_hours > least(8::numeric, v_total_hours) then
        raise exception using errcode = '22023', message = 'Target Hours cannot exceed the employee total working hours';
      end if;
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
      if exists (
        select 1 from public.overtime_entries ot
        where ot.company_id = v_company_id
          and ot.employee_id = v_daily_old.employee_id
          and ot.work_date = v_daily_old.work_date
          and ot.status = 'posted'
      ) then
        raise exception using errcode = 'P0001', message = 'Reverse the linked OT record before correcting this Daily Work record';
      end if;
      update public.daily_target_entries
      set status = 'reversed',
          reversed_at = pg_catalog.clock_timestamp(),
          reversed_by = p_actor,
          reversal_reason = 'Replaced by corrected Daily Work',
          updated_at = pg_catalog.clock_timestamp(),
          updated_by = p_actor
      where id = v_id;
      v_replaces_id := v_id;
      v_revision := v_daily_old.revision + 1;
    end if;

    v_hourly_target := case
      when v_is_absent then 0
      else pg_catalog.round(v_monthly_incentive / 200, 2)
    end;
    v_daily_target := pg_catalog.round(v_hourly_target * v_target_hours, 2);
    v_target_amount := pg_catalog.round(v_daily_target * v_target_percent / 100, 2);
    v_id := pg_catalog.gen_random_uuid();
    v_reference := private.new_reference('DT');
    insert into public.daily_target_entries (
      id, company_id, reference_no, employee_id, work_date, target_hours,
      hourly_target, daily_target, target_percent, target_amount,
      is_absent, in_time, out_time, total_hours, day_hours, night_ot_hours,
      activity, notes, revision, replaces_id, created_by, updated_by
    ) values (
      v_id, v_company_id, v_reference, v_employee_id, v_date, v_target_hours,
      v_hourly_target, v_daily_target, v_target_percent, v_target_amount,
      v_is_absent, v_in_time, v_out_time, v_total_hours, v_day_hours, v_night_ot_hours,
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'activity'), 2000), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 2000), ''),
      v_revision, v_replaces_id, p_actor, p_actor
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'overtime.upsert' then
    perform private.assert_permission('employees.write');
    v_employee_id := (v_payload ->> 'employee_id')::uuid;
    v_date := (v_payload ->> 'work_date')::date;
    select dt.in_time, dt.out_time, dt.is_absent, dt.night_ot_hours
    into v_in_time, v_out_time, v_is_absent, v_night_ot_hours
    from public.daily_target_entries dt
    where dt.company_id = v_company_id
      and dt.employee_id = v_employee_id
      and dt.work_date = v_date
      and dt.status = 'posted';
    if not found or v_is_absent or v_in_time is null or v_out_time is null then
      raise exception using errcode = '22023', message = 'Record present Daily Work with In and Out times before adding OT';
    end if;
    if v_night_ot_hours <= 0 then
      raise exception using errcode = '22023', message = 'No OT hours exist after the configured Day Shift End Time';
    end if;
    v_payload := (v_payload - 'hours' - 'target_hours') || pg_catalog.jsonb_build_object(
      'hours', v_night_ot_hours,
      'target_hours', v_night_ot_hours
    );
    return private.perform_operation_before_staff_workflow(p_operation, v_payload, p_actor);

  elsif p_operation = 'salary_advance.upsert' then
    perform private.assert_permission('payroll.write');
    v_employee_id := (v_payload ->> 'employee_id')::uuid;
    v_date := (v_payload ->> 'advance_date')::date;
    v_target_amount := pg_catalog.round((v_payload ->> 'amount')::numeric, 2);
    if v_target_amount <= 0 or v_target_amount::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '22023', message = 'Salary advance amount must be greater than zero';
    end if;
    perform 1 from public.employees e
    where e.id = v_employee_id and e.company_id = v_company_id and e.status = 'active';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active employee not found';
    end if;
    v_id := pg_catalog.gen_random_uuid();
    v_reference := private.new_reference('ADV');
    insert into public.employee_salary_advances (
      id, company_id, reference_no, employee_id, advance_date, amount, notes, created_by
    ) values (
      v_id, v_company_id, v_reference, v_employee_id, v_date, v_target_amount,
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 1000), ''), p_actor
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'idempotent', false
    );

  elsif p_operation = 'salary_advance.reverse' then
    perform private.assert_permission('payroll.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_advance_old
    from public.employee_salary_advances a
    where a.id = v_id and a.company_id = v_company_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Salary advance not found';
    end if;
    if v_advance_old.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Salary advance is already reversed';
    end if;
    if exists (
      select 1 from public.payroll_salary_advance_claims c
      where c.salary_advance_id = v_id and c.is_active
    ) then
      raise exception using errcode = 'P0001', message = 'A payroll has already deducted this salary advance';
    end if;
    update public.employee_salary_advances
    set status = 'reversed',
        reversed_at = pg_catalog.clock_timestamp(),
        reversed_by = p_actor,
        reversal_reason = coalesce(
          nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'reason'), 500), ''),
          'Salary advance reversed'
        )
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_advance_old.reference_no,
      'idempotent', false, 'reversed', true
    );

  elsif p_operation = 'payroll.post' then
    perform private.assert_permission('payroll.write');
    v_employee_id := (v_payload ->> 'employee_id')::uuid;
    v_salary_month := v_payload ->> 'salary_month';
    if coalesce(v_salary_month, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception using errcode = '22023', message = 'salary_month must use YYYY-MM';
    end if;
    v_month_start := pg_catalog.to_date(v_salary_month || '-01', 'YYYY-MM-DD');
    v_month_end := (v_month_start + interval '1 month')::date;

    perform a.id
    from public.employee_salary_advances a
    where a.company_id = v_company_id
      and a.employee_id = v_employee_id
      and a.advance_date >= v_month_start
      and a.advance_date < v_month_end
      and a.status = 'posted'
      and not exists (
        select 1 from public.payroll_salary_advance_claims c
        where c.salary_advance_id = a.id and c.is_active
      )
    order by a.id
    for update;

    select coalesce(pg_catalog.array_agg(a.id order by a.advance_date, a.id), array[]::uuid[]),
           coalesce(pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'type', 'salary_advance',
               'description', 'Salary advance ' || a.reference_no || ' · ' || pg_catalog.to_char(a.advance_date, 'YYYY-MM-DD'),
               'amount', a.amount,
               'account_code', 'PAYROLL_DEDUCTIONS_PAYABLE'
             ) order by a.advance_date, a.id
           ), '[]'::jsonb)
    into v_advance_ids, v_advance_deductions
    from public.employee_salary_advances a
    where a.company_id = v_company_id
      and a.employee_id = v_employee_id
      and a.advance_date >= v_month_start
      and a.advance_date < v_month_end
      and a.status = 'posted'
      and not exists (
        select 1 from public.payroll_salary_advance_claims c
        where c.salary_advance_id = a.id and c.is_active
      );

    if pg_catalog.jsonb_typeof(coalesce(v_payload -> 'deductions', '[]'::jsonb)) <> 'array' then
      raise exception using errcode = '22023', message = 'deductions must be an array';
    end if;
    select coalesce(pg_catalog.jsonb_agg(d.value), '[]'::jsonb)
    into v_manual_deductions
    from pg_catalog.jsonb_array_elements(coalesce(v_payload -> 'deductions', '[]'::jsonb)) d(value)
    where coalesce(d.value ->> 'type', '') <> 'salary_advance';
    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{deductions}',
      v_manual_deductions || v_advance_deductions,
      true
    );

    v_result := private.perform_operation_before_staff_workflow(p_operation, v_payload, p_actor);
    v_id := (v_result ->> 'id')::uuid;
    insert into public.payroll_salary_advance_claims (
      company_id, payroll_id, salary_advance_id, payroll_reference_no, created_by
    )
    select
      v_company_id, v_id, a.id,
      coalesce(v_result ->> 'reference_no', v_id::text), p_actor
    from public.employee_salary_advances a
    where a.id = any(v_advance_ids)
    order by a.advance_date, a.id;
    return v_result;

  elsif p_operation = 'payroll.reverse' then
    v_result := private.perform_operation_before_staff_workflow(p_operation, v_payload, p_actor);
    v_id := (v_payload ->> 'id')::uuid;
    update public.payroll_salary_advance_claims
    set is_active = false,
        released_at = pg_catalog.clock_timestamp(),
        released_by = p_actor
    where company_id = v_company_id
      and payroll_id = v_id
      and is_active;
    return v_result;
  end if;

  return private.perform_operation_before_staff_workflow(p_operation, p_payload, p_actor);
end;
$function$;

revoke all on function
  private.perform_operation_before_staff_workflow(text, jsonb, uuid),
  private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
