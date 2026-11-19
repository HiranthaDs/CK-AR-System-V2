begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

-- One credential per company exposes the finished-product catalogue to a
-- future website without exposing a Supabase secret or bypassing RLS. The raw
-- API key is never persisted; only its SHA-256 digest is stored.
create table public.catalog_api_credentials (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null unique references public.companies(id) on delete restrict,
  public_id uuid not null unique,
  secret_hash text not null,
  key_prefix text not null,
  status text not null default 'active',
  last_used_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  rotated_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint catalog_api_credentials_hash_valid check (
    pg_catalog.char_length(secret_hash) = 64
    and secret_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint catalog_api_credentials_prefix_valid check (
    pg_catalog.btrim(key_prefix) <> ''
    and pg_catalog.char_length(key_prefix) <= 24
  ),
  constraint catalog_api_credentials_status_valid check (
    status in ('active', 'revoked')
  )
);

create index catalog_api_credentials_active_lookup_idx
  on public.catalog_api_credentials (public_id, company_id)
  where status = 'active';

create trigger catalog_api_credentials_rpc_guard
before insert or update or delete on public.catalog_api_credentials
for each row execute function private.require_rpc_guard();

create trigger catalog_api_credentials_company_context
before insert or update on public.catalog_api_credentials
for each row execute function private.enforce_company_context();

alter table public.catalog_api_credentials enable row level security;

revoke all on table public.catalog_api_credentials
from public, anon, authenticated, service_role;

grant select (
  id, company_id, public_id, key_prefix, status, last_used_at,
  created_at, updated_at, rotated_at, created_by, updated_by
) on public.catalog_api_credentials to authenticated;

create policy catalog_api_credentials_admin_read
on public.catalog_api_credentials
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['system.admin']::text[]
));

-- The public catalogue integration endpoint calls this function with the
-- service role. A successful match returns only the owning company id.
create function public.erp_verify_catalog_api_credential(
  p_public_id uuid,
  p_secret_hash text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  if p_public_id is null
     or p_secret_hash is null
     or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select c.company_id
  into v_company_id
  from public.catalog_api_credentials c
  where c.public_id = p_public_id
    and c.secret_hash = p_secret_hash
    and c.status = 'active';

  if v_company_id is null then
    return null;
  end if;

  perform pg_catalog.set_config('app.erp_rpc_guard', 'enabled', true);
  perform pg_catalog.set_config('app.current_company_id', v_company_id::text, true);

  update public.catalog_api_credentials
  set last_used_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where public_id = p_public_id and company_id = v_company_id;

  return v_company_id;
end;
$function$;

revoke all on function public.erp_verify_catalog_api_credential(uuid, text)
from public, anon, authenticated;
grant execute on function public.erp_verify_catalog_api_credential(uuid, text)
to service_role;

-- Make the account safety classification available to the universal journal
-- UI. Existing view columns remain in their original order for compatibility.
create or replace view public.account_balances
with (security_invoker = true)
as
select
  a.id as account_id,
  a.code as account_code,
  a.name as account_name,
  a.category,
  a.normal_side,
  coalesce(pg_catalog.sum(jl.debit), 0::numeric)::numeric(20,2) as debit_total,
  coalesce(pg_catalog.sum(jl.credit), 0::numeric)::numeric(20,2) as credit_total,
  case when a.normal_side = 'debit'
    then coalesce(pg_catalog.sum(jl.debit - jl.credit), 0::numeric)
    else coalesce(pg_catalog.sum(jl.credit - jl.debit), 0::numeric)
  end::numeric(20,2) as balance,
  c.id as company_id,
  a.is_control,
  a.allow_manual_posting
from public.companies c
cross join public.accounts a
left join public.journal_lines jl
  on jl.account_id = a.id and jl.company_id = c.id
where c.is_active
group by c.id, a.id, a.code, a.name, a.category, a.normal_side,
         a.is_control, a.allow_manual_posting;

create or replace view public.account_balances_by_year
with (security_invoker = true)
as
select
  years.fiscal_year,
  a.id as account_id,
  a.code as account_code,
  a.name as account_name,
  a.category,
  a.normal_side,
  coalesce(pg_catalog.sum(jl.debit) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0)::numeric(20,2) as debit_total,
  coalesce(pg_catalog.sum(jl.credit) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0)::numeric(20,2) as credit_total,
  case when a.normal_side = 'debit' then coalesce(pg_catalog.sum(
    jl.debit - jl.credit
  ) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0) else coalesce(pg_catalog.sum(
    jl.credit - jl.debit
  ) filter (
    where je.journal_date < pg_catalog.make_date(years.fiscal_year + 1, 1, 1)
  ), 0) end::numeric(20,2) as balance,
  years.company_id,
  a.is_control,
  a.allow_manual_posting
from (
  select c.id as company_id, y.fiscal_year
  from public.companies c
  cross join lateral (
    select pg_catalog.generate_series(2000, 2200)::integer as fiscal_year
  ) y
  where c.is_active
) years
cross join public.accounts a
left join public.journal_entries je on je.company_id = years.company_id
left join public.journal_lines jl
  on jl.journal_entry_id = je.id and jl.account_id = a.id
group by years.company_id, years.fiscal_year,
         a.id, a.code, a.name, a.category, a.normal_side,
         a.is_control, a.allow_manual_posting;

-- Extend the guarded dispatcher with credential lifecycle operations and an
-- explicit, audited control-account override for the universal journal.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_v2_before_catalog_integrations;

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
  v_company_id uuid := private.current_company_id();
  v_payload jsonb := p_payload;
  v_result jsonb;
  v_id uuid;
  v_target_id uuid;
  v_journal_id uuid;
  v_reversal_journal_id uuid;
  v_public_id uuid;
  v_reference text;
  v_reason text;
  v_date date;
  v_lines jsonb;
  v_journal public.journal_entries%rowtype;
begin
  if p_operation not in (
    'catalog_api_credential.rotate', 'catalog_api_credential.revoke',
    'journal.post', 'journal.reverse', 'journal.replace'
  ) then
    return private.perform_operation_v2_before_catalog_integrations(
      p_operation, p_payload, p_actor
    );
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

  if p_operation = 'catalog_api_credential.rotate' then
    perform private.assert_permission('system.admin');
    v_public_id := (v_payload ->> 'public_id')::uuid;
    if v_payload ->> 'secret_hash' !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'A valid catalogue API key hash is required';
    end if;
    if nullif(pg_catalog.btrim(v_payload ->> 'key_prefix'), '') is null
       or pg_catalog.char_length(v_payload ->> 'key_prefix') > 24 then
      raise exception using errcode = '22023', message = 'A valid catalogue API key prefix is required';
    end if;

    insert into public.catalog_api_credentials (
      company_id, public_id, secret_hash, key_prefix, status,
      created_by, updated_by
    ) values (
      v_company_id, v_public_id, v_payload ->> 'secret_hash',
      pg_catalog.btrim(v_payload ->> 'key_prefix'), 'active', p_actor, p_actor
    )
    on conflict (company_id) do update
    set public_id = excluded.public_id,
        secret_hash = excluded.secret_hash,
        key_prefix = excluded.key_prefix,
        status = 'active',
        last_used_at = null,
        updated_at = pg_catalog.clock_timestamp(),
        rotated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    returning id into v_id;

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'public_id', v_public_id, 'idempotent', false
    );

  elsif p_operation = 'catalog_api_credential.revoke' then
    perform private.assert_permission('system.admin');
    update public.catalog_api_credentials
    set status = 'revoked',
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where company_id = v_company_id
    returning id, public_id into v_id, v_public_id;

    if not found then
      raise exception using errcode = 'P0001', message = 'Catalogue API credential not found';
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'public_id', v_public_id, 'idempotent', false, 'revoked', true
    );

  elsif p_operation = 'journal.post' then
    if coalesce(v_payload ->> 'allow_control_accounts', 'false') <> 'true' then
      return private.perform_operation_v2_before_catalog_integrations(
        p_operation, p_payload, p_actor
      );
    end if;

    perform private.assert_permission('finance.write');
    if coalesce(v_payload ->> 'control_account_override_acknowledged', 'false') <> 'true' then
      raise exception using errcode = '42501', message = 'The control-account warning must be acknowledged';
    end if;

    v_id := pg_catalog.gen_random_uuid();
    v_date := (v_payload ->> 'journal_date')::date;
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''),
      private.new_reference('JRN')
    );
    v_lines := coalesce(v_payload -> 'lines', '[]'::jsonb);
    v_journal_id := private.post_journal(
      v_date, v_payload ->> 'memo', 'manual_override', v_id,
      v_lines, p_actor, v_reference, null
    );

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_journal_id,
      'reference_no', v_reference, 'idempotent', false,
      'control_account_override', true
    );

  elsif p_operation = 'journal.reverse' then
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_journal
    from public.journal_entries
    where id = v_id and company_id = v_company_id
    for update;

    if not found or v_journal.source_type <> 'manual_override' then
      return private.perform_operation_v2_before_catalog_integrations(
        p_operation, p_payload, p_actor
      );
    end if;

    perform private.assert_permission('finance.write');
    v_reason := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''),
      'Universal journal reversed'
    );
    v_reversal_journal_id := private.reverse_journal(
      v_id, current_date, p_actor, v_reason
    );

    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_journal.reference_no,
      'idempotent', false, 'reversed', true,
      'reversal_journal_id', v_reversal_journal_id
    );

  else
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_journal
    from public.journal_entries
    where id = v_target_id and company_id = v_company_id
    for update;

    if not found or v_journal.source_type <> 'manual_override' then
      return private.perform_operation_v2_before_catalog_integrations(
        p_operation, p_payload, p_actor
      );
    end if;

    perform private.assert_permission('finance.write');
    perform private.perform_operation_v2(
      'journal.reverse',
      pg_catalog.jsonb_build_object(
        'id', v_target_id,
        'reason', 'Replaced by corrected universal journal'
      ),
      p_actor
    );

    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'allow_control_accounts', true,
        'control_account_override_acknowledged', true
      );
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_journal.reference_no then
      v_payload := pg_catalog.jsonb_set(
        v_payload, '{reference_no}', pg_catalog.to_jsonb(private.new_reference('JRN'))
      );
    end if;

    v_result := private.perform_operation_v2('journal.post', v_payload, p_actor);
    return v_result || pg_catalog.jsonb_build_object('operation', p_operation);
  end if;
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
