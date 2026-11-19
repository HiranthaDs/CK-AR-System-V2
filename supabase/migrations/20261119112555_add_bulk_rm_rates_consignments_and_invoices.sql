begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

-- Invoice identity belongs to the legal company rather than to the browser.
alter table public.companies
  add column if not exists address text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists logo_url text;

alter table public.companies
  drop constraint if exists companies_invoice_profile_valid;
alter table public.companies
  add constraint companies_invoice_profile_valid check (
    (address is null or pg_catalog.char_length(address) <= 500)
    and (phone is null or pg_catalog.char_length(phone) <= 40)
    and (email is null or (
      pg_catalog.char_length(email) <= 254
      and email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ))
    and (logo_url is null or (
      pg_catalog.char_length(logo_url) <= 1000
      and logo_url ~ '^https://'
    ))
  );

create table public.bulk_rm_rates (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  material_type text not null,
  rate_per_kg numeric(20,6) not null,
  effective_from date not null,
  effective_to date,
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint bulk_rm_rates_material_not_blank check (pg_catalog.btrim(material_type) <> ''),
  constraint bulk_rm_rates_material_length check (pg_catalog.char_length(material_type) <= 160),
  constraint bulk_rm_rates_rate_positive check (rate_per_kg > 0),
  constraint bulk_rm_rates_dates_valid check (effective_to is null or effective_to >= effective_from),
  constraint bulk_rm_rates_status_valid check (status in ('active', 'inactive')),
  constraint bulk_rm_rates_notes_length check (notes is null or pg_catalog.char_length(notes) <= 2000),
  unique (company_id, material_type, effective_from)
);

create index bulk_rm_rates_company_effective_idx
  on public.bulk_rm_rates (company_id, status, effective_from desc, effective_to, id);
create index bulk_rm_rates_company_material_idx
  on public.bulk_rm_rates (company_id, pg_catalog.lower(material_type), effective_from desc, id);

create table public.raw_material_purchase_consignments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  document_no bigint generated always as identity,
  company_id uuid not null references public.companies(id) on delete restrict,
  reference_no text not null unique,
  invoice_no text not null unique,
  purchase_date date not null,
  payment_method text not null,
  supplier_name text,
  supplier_phone text,
  lorry_no text,
  notes text,
  grand_total numeric(20,2) not null,
  status text not null default 'posted',
  replaces_id uuid references public.raw_material_purchase_consignments(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint raw_material_purchase_consignments_reference_not_blank check (pg_catalog.btrim(reference_no) <> ''),
  constraint raw_material_purchase_consignments_invoice_not_blank check (pg_catalog.btrim(invoice_no) <> ''),
  constraint raw_material_purchase_consignments_payment_valid check (payment_method in ('cash', 'bank_transfer', 'cheque', 'credit')),
  constraint raw_material_purchase_consignments_total_positive check (grand_total > 0),
  constraint raw_material_purchase_consignments_status_valid check (status in ('posted', 'reversed')),
  constraint raw_material_purchase_consignments_text_lengths check (
    (supplier_name is null or pg_catalog.char_length(supplier_name) <= 160)
    and (supplier_phone is null or pg_catalog.char_length(supplier_phone) <= 40)
    and (lorry_no is null or pg_catalog.char_length(lorry_no) <= 80)
    and (notes is null or pg_catalog.char_length(notes) <= 2000)
  ),
  constraint raw_material_purchase_consignments_reversal_state check (
    (status = 'posted' and reversed_at is null and reversed_by is null)
    or (status = 'reversed' and reversed_at is not null and reversed_by is not null)
  )
);

create index raw_material_purchase_consignments_company_date_idx
  on public.raw_material_purchase_consignments (company_id, purchase_date desc, id desc);
create index raw_material_purchase_consignments_company_supplier_idx
  on public.raw_material_purchase_consignments (company_id, pg_catalog.lower(supplier_name), purchase_date desc)
  where supplier_name is not null;
create index raw_material_purchase_consignments_replaces_idx
  on public.raw_material_purchase_consignments (replaces_id)
  where replaces_id is not null;

alter table public.raw_material_purchases
  add column if not exists consignment_id uuid,
  add column if not exists bulk_rm_rate_id uuid,
  add column if not exists rate_per_kg numeric(20,6),
  add column if not exists line_no integer;

alter table public.raw_material_purchases
  drop constraint if exists raw_material_purchases_consignment_id_fkey,
  drop constraint if exists raw_material_purchases_bulk_rm_rate_id_fkey,
  drop constraint if exists raw_material_purchases_rate_positive,
  drop constraint if exists raw_material_purchases_line_no_positive;
alter table public.raw_material_purchases
  add constraint raw_material_purchases_consignment_id_fkey
    foreign key (consignment_id)
    references public.raw_material_purchase_consignments(id) on delete restrict,
  add constraint raw_material_purchases_bulk_rm_rate_id_fkey
    foreign key (bulk_rm_rate_id)
    references public.bulk_rm_rates(id) on delete set null,
  add constraint raw_material_purchases_rate_positive
    check (rate_per_kg is null or rate_per_kg > 0),
  add constraint raw_material_purchases_line_no_positive
    check (line_no is null or line_no > 0);

create index raw_material_purchases_consignment_idx
  on public.raw_material_purchases (company_id, consignment_id, id);
create index raw_material_purchases_bulk_rm_rate_idx
  on public.raw_material_purchases (bulk_rm_rate_id)
  where bulk_rm_rate_id is not null;
create unique index raw_material_purchases_consignment_line_no_idx
  on public.raw_material_purchases (consignment_id, line_no)
  where consignment_id is not null and line_no is not null;

-- Preserve every historical single-line purchase as a one-line consignment.
insert into public.raw_material_purchase_consignments (
  id, company_id, reference_no, invoice_no, purchase_date, payment_method,
  supplier_name, supplier_phone, notes, grand_total, status, replaces_id,
  reversed_at, reversed_by, reversal_reason, created_at, updated_at,
  created_by, updated_by
)
select
  r.id, r.company_id, r.reference_no, 'LEGACY-' || r.reference_no,
  r.purchase_date, r.payment_method, r.supplier_name, r.supplier_phone,
  r.notes, r.total_cost, r.status, r.replaces_id, r.reversed_at,
  r.reversed_by, r.reversal_reason, r.created_at, r.updated_at,
  r.created_by, r.updated_by
from public.raw_material_purchases r
where r.consignment_id is null
on conflict (id) do nothing;

do $backfill_purchase_lines$
declare
  v_company_id uuid;
begin
  perform pg_catalog.set_config('app.erp_rpc_guard', 'enabled', true);
  for v_company_id in select c.id from public.companies c order by c.id
  loop
    perform pg_catalog.set_config('app.current_company_id', v_company_id::text, true);
    update public.raw_material_purchases r
    set consignment_id = r.id,
        rate_per_kg = pg_catalog.round(r.total_cost / r.quantity_kg, 6),
        line_no = 1
    where r.company_id = v_company_id and r.consignment_id is null;
  end loop;
  perform pg_catalog.set_config('app.current_company_id', '', true);
  perform pg_catalog.set_config('app.erp_rpc_guard', '', true);
end;
$backfill_purchase_lines$;

-- Direct Data API writes remain disabled. All mutations pass through the
-- guarded, company-scoped ERP facade below.
create trigger bulk_rm_rates_rpc_guard
before insert or update or delete on public.bulk_rm_rates
for each row execute function private.require_rpc_guard();
create trigger bulk_rm_rates_company_context
before insert or update on public.bulk_rm_rates
for each row execute function private.enforce_company_context();
create trigger bulk_rm_rates_finite_numbers
before insert or update on public.bulk_rm_rates
for each row execute function private.reject_non_finite_columns('rate_per_kg');

create trigger raw_material_purchase_consignments_rpc_guard
before insert or update or delete on public.raw_material_purchase_consignments
for each row execute function private.require_rpc_guard();
create trigger raw_material_purchase_consignments_company_context
before insert or update on public.raw_material_purchase_consignments
for each row execute function private.enforce_company_context();
create trigger raw_material_purchase_consignments_finite_numbers
before insert or update on public.raw_material_purchase_consignments
for each row execute function private.reject_non_finite_columns('grand_total');

alter table public.bulk_rm_rates enable row level security;
alter table public.raw_material_purchase_consignments enable row level security;

revoke all on table public.bulk_rm_rates, public.raw_material_purchase_consignments
from public, anon, authenticated;
grant select on table public.bulk_rm_rates, public.raw_material_purchase_consignments
to authenticated;
revoke all on sequence public.raw_material_purchase_consignments_document_no_seq
from public, anon, authenticated;

create policy bulk_rm_rates_read on public.bulk_rm_rates
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['inventory.read','production.read','reports.read']::text[]
));

create policy raw_material_purchase_consignments_read
on public.raw_material_purchase_consignments
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['inventory.read','production.read','reports.read','dashboard.read']::text[]
));

-- Wrap the active dispatcher. Existing stock movements and journals continue
-- to be posted by the audited single-line purchase operation; this wrapper
-- groups those atomic lines under one lorry/bill and one invoice.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_v2_before_bulk_rm_consignments;

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
  v_company_code text;
  v_payload jsonb := p_payload;
  v_items jsonb;
  v_line jsonb;
  v_result jsonb;
  v_rate public.bulk_rm_rates%rowtype;
  v_purchase public.raw_material_purchase_consignments%rowtype;
  v_id uuid;
  v_target_id uuid;
  v_child_id uuid;
  v_rate_id uuid;
  v_reference text;
  v_invoice_no text;
  v_material_type text;
  v_status text;
  v_date date;
  v_effective_to date;
  v_document_no bigint;
  v_quantity numeric(20,6);
  v_rate_value numeric(20,6);
  v_line_total numeric(20,2);
  v_grand_total numeric(20,2) := 0;
  v_seen_rate_ids uuid[] := array[]::uuid[];
begin
  if p_operation not in (
    'bulk_rm_rate.upsert', 'bulk_rm_rate.deactivate',
    'rm_purchase.post', 'rm_purchase.replace', 'rm_purchase.reverse',
    'company_profile.update', 'system.purge_business_data'
  ) then
    return private.perform_operation_v2_before_bulk_rm_consignments(
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

  if p_operation = 'bulk_rm_rate.upsert' then
    perform private.assert_permission('inventory.write');
    v_id := case when nullif(v_payload ->> 'id', '') is null
      then pg_catalog.gen_random_uuid() else (v_payload ->> 'id')::uuid end;
    v_material_type := nullif(pg_catalog.btrim(v_payload ->> 'material_type'), '');
    v_rate_value := pg_catalog.round((v_payload ->> 'rate_per_kg')::numeric, 6);
    v_date := (v_payload ->> 'effective_from')::date;
    v_effective_to := nullif(v_payload ->> 'effective_to', '')::date;
    v_status := coalesce(nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'status')), ''), 'active');
    if v_material_type is null or pg_catalog.char_length(v_material_type) > 160 then
      raise exception using errcode = '22023', message = 'A valid Bulk RM type is required';
    end if;
    if v_rate_value <= 0 or v_status not in ('active', 'inactive')
       or (v_effective_to is not null and v_effective_to < v_date) then
      raise exception using errcode = '22023', message = 'Bulk RM rate, dates, or status are invalid';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'bulk-rm-rate:' || v_company_id::text || ':' || pg_catalog.lower(v_material_type), 0
    ));
    if v_status = 'active' and exists (
      select 1
      from public.bulk_rm_rates r
      where r.company_id = v_company_id
        and r.id <> v_id
        and r.status = 'active'
        and pg_catalog.lower(r.material_type) = pg_catalog.lower(v_material_type)
        and pg_catalog.daterange(r.effective_from, coalesce(r.effective_to + 1, 'infinity'::date), '[)')
          && pg_catalog.daterange(v_date, coalesce(v_effective_to + 1, 'infinity'::date), '[)')
    ) then
      raise exception using errcode = '23514', message = 'An active Bulk RM rate already covers part of this effective period';
    end if;

    insert into public.bulk_rm_rates (
      id, company_id, material_type, rate_per_kg, effective_from,
      effective_to, status, notes, created_by, updated_by
    ) values (
      v_id, v_company_id, v_material_type, v_rate_value, v_date,
      v_effective_to, v_status,
      nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''), p_actor, p_actor
    )
    on conflict (id) do update
    set material_type = excluded.material_type,
        rate_per_kg = excluded.rate_per_kg,
        effective_from = excluded.effective_from,
        effective_to = excluded.effective_to,
        status = excluded.status,
        notes = excluded.notes,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where public.bulk_rm_rates.company_id = v_company_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'Bulk RM rate not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_material_type, 'idempotent', false
    );

  elsif p_operation = 'bulk_rm_rate.deactivate' then
    perform private.assert_permission('inventory.write');
    v_id := (v_payload ->> 'id')::uuid;
    update public.bulk_rm_rates
    set status = 'inactive',
        effective_to = coalesce(effective_to, pg_catalog.greatest(effective_from, current_date)),
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id and status = 'active'
    returning material_type into v_material_type;
    if not found then
      raise exception using errcode = 'P0001', message = 'Active Bulk RM rate not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_material_type, 'idempotent', false
    );

  elsif p_operation = 'company_profile.update' then
    perform private.assert_permission('system.admin');
    if nullif(pg_catalog.btrim(v_payload ->> 'email'), '') is not null and
       nullif(pg_catalog.btrim(v_payload ->> 'email'), '') !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception using errcode = '22023', message = 'Company email is invalid';
    end if;
    if nullif(pg_catalog.btrim(v_payload ->> 'logo_url'), '') is not null and
       nullif(pg_catalog.btrim(v_payload ->> 'logo_url'), '') !~ '^https://' then
      raise exception using errcode = '22023', message = 'Company logo URL must use HTTPS';
    end if;
    update public.companies
    set address = case when v_payload ? 'address'
          then nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'address'), 500), '') else address end,
        phone = case when v_payload ? 'phone'
          then nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'phone'), 40), '') else phone end,
        email = case when v_payload ? 'email'
          then nullif(pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'email')), 254), '') else email end,
        logo_url = case when v_payload ? 'logo_url'
          then nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'logo_url'), 1000), '') else logo_url end,
        updated_at = pg_catalog.clock_timestamp()
    where id = v_company_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_company_id,
      'reference_no', v_company_id::text, 'idempotent', false
    );

  elsif p_operation = 'rm_purchase.replace' then
    perform private.assert_permission('inventory.write');
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select * into v_purchase
    from public.raw_material_purchase_consignments
    where id = v_target_id and company_id = v_company_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Raw-material consignment not found';
    end if;
    perform private.perform_operation_v2(
      'rm_purchase.reverse',
      pg_catalog.jsonb_build_object('id', v_target_id, 'reason', 'Replaced by corrected consignment'),
      p_actor
    );
    v_payload := coalesce(v_payload -> 'replacement', '{}'::jsonb)
      || pg_catalog.jsonb_build_object('_replaces_id', v_target_id);
    if nullif(v_payload ->> 'reference_no', '') is null
       or v_payload ->> 'reference_no' = v_purchase.reference_no then
      v_payload := pg_catalog.jsonb_set(
        v_payload, '{reference_no}', pg_catalog.to_jsonb(private.new_reference('RMC'))
      );
    end if;
    return private.perform_operation_v2('rm_purchase.post', v_payload, p_actor)
      || pg_catalog.jsonb_build_object('operation', p_operation);

  elsif p_operation = 'rm_purchase.post' then
    perform private.assert_permission('inventory.write');
    v_items := coalesce(v_payload -> 'items', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_items) <> 'array'
       or pg_catalog.jsonb_array_length(v_items) not between 1 and 100 then
      raise exception using errcode = '22023', message = 'A purchase requires 1 to 100 raw-material lines';
    end if;
    v_date := (v_payload ->> 'purchase_date')::date;
    v_status := pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'payment_method'));
    if v_status not in ('cash', 'bank_transfer', 'cheque', 'credit') then
      raise exception using errcode = '22023', message = 'Unsupported purchase payment method';
    end if;

    for v_line in
      select value || pg_catalog.jsonb_build_object('_line_no', ordinality)
      from pg_catalog.jsonb_array_elements(v_items) with ordinality
    loop
      v_rate_id := (v_line ->> 'bulk_rm_rate_id')::uuid;
      if v_rate_id = any(v_seen_rate_ids) then
        raise exception using errcode = '23514', message = 'Each Bulk RM type may appear only once per consignment';
      end if;
      v_seen_rate_ids := pg_catalog.array_append(v_seen_rate_ids, v_rate_id);
      select * into v_rate
      from public.bulk_rm_rates r
      where r.id = v_rate_id
        and r.company_id = v_company_id
        and r.status = 'active'
        and r.effective_from <= v_date
        and (r.effective_to is null or r.effective_to >= v_date);
      if not found then
        raise exception using errcode = 'P0001', message = 'An active Bulk RM rate was not found for the purchase date';
      end if;
      v_quantity := pg_catalog.round((v_line ->> 'quantity_kg')::numeric, 6);
      v_rate_value := pg_catalog.round((v_line ->> 'rate_per_kg')::numeric, 6);
      if v_quantity <= 0 or v_rate_value <= 0 then
        raise exception using errcode = '22023', message = 'Raw-material quantity and rate must be positive';
      end if;
      v_line_total := pg_catalog.round(v_quantity * v_rate_value, 2);
      v_grand_total := v_grand_total + v_line_total;
    end loop;

    v_id := pg_catalog.gen_random_uuid();
    v_reference := coalesce(
      nullif(pg_catalog.btrim(v_payload ->> 'reference_no'), ''),
      private.new_reference('RMC')
    );
    insert into public.raw_material_purchase_consignments (
      id, company_id, reference_no, invoice_no, purchase_date,
      payment_method, supplier_name, supplier_phone, lorry_no, notes,
      grand_total, replaces_id, created_by, updated_by
    ) values (
      v_id, v_company_id, pg_catalog.left(v_reference, 80), 'PENDING-' || v_id::text,
      v_date, v_status,
      nullif(pg_catalog.btrim(v_payload ->> 'supplier_name'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'supplier_phone'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'lorry_no'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'notes'), ''),
      v_grand_total, nullif(v_payload ->> '_replaces_id', '')::uuid,
      p_actor, p_actor
    ) returning document_no into v_document_no;
    select c.code into v_company_code from public.companies c where c.id = v_company_id;
    v_invoice_no := 'RM-' || v_company_code || 'P-' || pg_catalog.lpad(v_document_no::text, 4, '0');
    update public.raw_material_purchase_consignments
    set invoice_no = v_invoice_no,
        updated_at = pg_catalog.clock_timestamp()
    where id = v_id;

    v_seen_rate_ids := array[]::uuid[];
    for v_line in
      select value || pg_catalog.jsonb_build_object('_line_no', ordinality)
      from pg_catalog.jsonb_array_elements(v_items) with ordinality
    loop
      v_rate_id := (v_line ->> 'bulk_rm_rate_id')::uuid;
      select * into v_rate from public.bulk_rm_rates where id = v_rate_id;
      v_quantity := pg_catalog.round((v_line ->> 'quantity_kg')::numeric, 6);
      v_rate_value := pg_catalog.round((v_line ->> 'rate_per_kg')::numeric, 6);
      v_line_total := pg_catalog.round(v_quantity * v_rate_value, 2);
      v_result := private.perform_operation_v2_before_bulk_rm_consignments(
        'rm_purchase.post',
        pg_catalog.jsonb_build_object(
          'purchase_date', v_date,
          'material_name', v_rate.material_type,
          'supplier_name', nullif(pg_catalog.btrim(v_payload ->> 'supplier_name'), ''),
          'supplier_phone', nullif(pg_catalog.btrim(v_payload ->> 'supplier_phone'), ''),
          'quantity_kg', v_quantity,
          'total_cost', v_line_total,
          'payment_method', v_status,
          'notes', nullif(pg_catalog.btrim(v_line ->> 'notes'), ''),
          'company_id', v_company_id
        ),
        p_actor
      );
      v_child_id := (v_result ->> 'id')::uuid;
      update public.raw_material_purchases
      set consignment_id = v_id,
          bulk_rm_rate_id = v_rate_id,
          rate_per_kg = v_rate_value,
          line_no = (v_line ->> '_line_no')::integer,
          updated_at = pg_catalog.clock_timestamp(),
          updated_by = p_actor
      where id = v_child_id and company_id = v_company_id;
      if not found then
        raise exception using errcode = 'P0001', message = 'Raw-material purchase line was not created';
      end if;
    end loop;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_reference, 'invoice_no', v_invoice_no,
      'idempotent', false
    );

  elsif p_operation = 'rm_purchase.reverse' then
    perform private.assert_permission('inventory.write');
    v_id := (v_payload ->> 'id')::uuid;
    select * into v_purchase
    from public.raw_material_purchase_consignments
    where id = v_id and company_id = v_company_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Raw-material consignment not found';
    end if;
    if v_purchase.status <> 'posted' then
      raise exception using errcode = 'P0001', message = 'Raw-material consignment is already reversed';
    end if;
    for v_child_id in
      select r.id
      from public.raw_material_purchases r
      where r.consignment_id = v_id and r.company_id = v_company_id and r.status = 'posted'
      order by r.id
      for update
    loop
      perform private.perform_operation_v2_before_bulk_rm_consignments(
        'rm_purchase.reverse',
        pg_catalog.jsonb_build_object(
          'id', v_child_id,
          'reason', coalesce(nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Raw-material consignment reversed'),
          'company_id', v_company_id
        ),
        p_actor
      );
    end loop;
    update public.raw_material_purchase_consignments
    set status = 'reversed',
        reversed_at = pg_catalog.clock_timestamp(),
        reversed_by = p_actor,
        reversal_reason = coalesce(nullif(pg_catalog.btrim(v_payload ->> 'reason'), ''), 'Raw-material consignment reversed'),
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_purchase.reference_no, 'invoice_no', v_purchase.invoice_no,
      'idempotent', false, 'reversed', true
    );

  else
    v_result := private.perform_operation_v2_before_bulk_rm_consignments(
      p_operation, p_payload, p_actor
    );
    delete from public.raw_material_purchase_consignments where company_id = v_company_id;
    delete from public.bulk_rm_rates where company_id = v_company_id;
    return v_result;
  end if;
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
