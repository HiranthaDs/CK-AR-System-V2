-- Store a conversion rate's conversion master and work description as one
-- atomic write. Earlier wrappers temporarily wrote the conversion type name
-- into work_type before restoring the submitted work type. The legacy
-- (work_type, effective_from) constraint could reject that intermediate value,
-- especially when several conversion types use the standard "Grinding" task.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter table public.piecework_rates
  drop constraint if exists piecework_rates_work_type_effective_from_key;

-- A legacy manually-created rate can predate the conversion-type link. Only
-- backfill when its work label has exactly one matching conversion material
-- prefix (for example, "ABS Grinding" -> "ABS Bulk to ABS Chip").
with unambiguous_matches as (
  select r.id as rate_id, pg_catalog.min(t.id::text)::uuid as conversion_type_id
  from public.piecework_rates r
  join public.conversion_types t
    on pg_catalog.lower(pg_catalog.btrim(r.work_type)) = pg_catalog.lower(pg_catalog.btrim(t.name))
    or pg_catalog.lower(pg_catalog.btrim(r.work_type)) like
      pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(t.name, ' Bulk to ', 1))) || ' %'
  where r.conversion_type_id is null
  group by r.id
  having pg_catalog.count(*) = 1
)
update public.piecework_rates r
set conversion_type_id = m.conversion_type_id,
    updated_at = pg_catalog.clock_timestamp()
from unambiguous_matches m
where r.id = m.rate_id;

do $migration$
begin
  if exists (
    select 1
    from public.piecework_rates r
    where r.conversion_type_id is null
  ) then
    raise exception using
      errcode = '23502',
      message = 'A legacy conversion rate could not be linked to exactly one conversion type',
      hint = 'Link every legacy piecework rate to its conversion type before retrying this migration.';
  end if;
end;
$migration$;

alter table public.piecework_rates
  alter column conversion_type_id set not null;

create unique index piecework_rates_conversion_work_effective_from_uidx
  on public.piecework_rates (
    conversion_type_id,
    pg_catalog.lower(pg_catalog.btrim(work_type)),
    effective_from
  );

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_atomic_piecework_rates;

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
  v_id uuid;
  v_type_id uuid;
  v_work_type text;
  v_work_key text;
  v_rate numeric(20,6);
  v_effective_from date;
  v_effective_to date;
  v_status text;
  v_type_name text;
begin
  if p_operation <> 'piecework_rate.upsert' then
    return private.perform_operation_before_atomic_piecework_rates(
      p_operation,
      p_payload,
      p_actor
    );
  end if;

  if not (select private.has_any_permission(
    array['employees.write', 'inventory.write', 'production.write']::text[]
  )) then
    raise exception using
      errcode = '42501',
      message = 'Conversion rate write permission is required';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Conversion rate payload must be a JSON object';
  end if;

  v_id := coalesce(
    nullif(p_payload ->> 'id', '')::uuid,
    pg_catalog.gen_random_uuid()
  );
  v_type_id := nullif(p_payload ->> 'conversion_type_id', '')::uuid;
  v_work_type := nullif(pg_catalog.btrim(p_payload ->> 'work_type'), '');
  v_work_key := pg_catalog.lower(v_work_type);
  v_rate := pg_catalog.round((p_payload ->> 'rate_per_kg')::numeric, 6);
  v_effective_from := (p_payload ->> 'effective_from')::date;
  v_effective_to := nullif(p_payload ->> 'effective_to', '')::date;
  v_status := coalesce(nullif(p_payload ->> 'status', ''), 'active');

  if v_type_id is null then
    raise exception using errcode = '22023', message = 'Conversion type is required';
  end if;
  if v_work_type is null then
    raise exception using errcode = '22023', message = 'Work type is required';
  end if;
  if v_rate is null or v_rate <= 0 then
    raise exception using errcode = '22023', message = 'Rate per kg must be greater than zero';
  end if;
  if v_effective_from is null then
    raise exception using errcode = '22023', message = 'Effective date is required';
  end if;
  if v_effective_to is not null and v_effective_to < v_effective_from then
    raise exception using errcode = '22023', message = 'Effective end date cannot be before the start date';
  end if;
  if v_status not in ('active', 'inactive') then
    raise exception using errcode = '22023', message = 'Conversion rate status is invalid';
  end if;

  select t.name
  into v_type_name
  from public.conversion_types t
  where t.id = v_type_id
    and t.status = 'active';
  if not found then
    raise exception using errcode = 'P0001', message = 'Active conversion type not found';
  end if;

  -- Serialize every rate change for one conversion type. This makes the
  -- following overlap check safe even when two users save at the same time.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('piecework-rate-type:' || v_type_id::text, 0)
  );

  if nullif(p_payload ->> 'id', '') is not null then
    perform 1
    from public.piecework_rates r
    where r.id = v_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Conversion rate not found';
    end if;
  end if;

  if exists (
    select 1
    from public.piecework_rates r
    where r.conversion_type_id = v_type_id
      and pg_catalog.lower(pg_catalog.btrim(r.work_type)) = v_work_key
      and r.effective_from = v_effective_from
      and r.id <> v_id
  ) then
    raise exception using
      errcode = '23505',
      message = 'A conversion rate already exists for this conversion type, work type, and effective date',
      hint = 'Edit the existing rate or choose a different effective date.';
  end if;

  if v_status = 'active' and exists (
    select 1
    from public.piecework_rates r
    where r.conversion_type_id = v_type_id
      and pg_catalog.lower(pg_catalog.btrim(r.work_type)) = v_work_key
      and r.status = 'active'
      and r.id <> v_id
      and pg_catalog.daterange(
        r.effective_from,
        coalesce(r.effective_to, 'infinity'::date),
        '[]'
      ) && pg_catalog.daterange(
        v_effective_from,
        coalesce(v_effective_to, 'infinity'::date),
        '[]'
      )
  ) then
    raise exception using
      errcode = '23505',
      message = 'An active conversion rate already covers part of this effective period',
      hint = 'End the earlier rate before this rate begins, or edit the existing rate.';
  end if;

  insert into public.piecework_rates (
    id,
    conversion_type_id,
    work_type,
    rate_per_kg,
    effective_from,
    effective_to,
    status,
    notes,
    created_by,
    updated_by
  ) values (
    v_id,
    v_type_id,
    pg_catalog.left(v_work_type, 160),
    v_rate,
    v_effective_from,
    v_effective_to,
    v_status,
    nullif(pg_catalog.btrim(p_payload ->> 'notes'), ''),
    p_actor,
    p_actor
  )
  on conflict (id) do update
  set conversion_type_id = excluded.conversion_type_id,
      work_type = excluded.work_type,
      rate_per_kg = excluded.rate_per_kg,
      effective_from = excluded.effective_from,
      effective_to = excluded.effective_to,
      status = excluded.status,
      notes = excluded.notes,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', p_operation,
    'id', v_id,
    'reference_no', v_type_name || ' / ' || v_work_type,
    'idempotent', false
  );
end;
$function$;

revoke all on function
  private.perform_operation_before_atomic_piecework_rates(text, jsonb, uuid),
  private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
