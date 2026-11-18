-- Reusable finished-product catalogue details and non-posting customer quotations.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter table public.inventory_items
  add column product_type text,
  add constraint inventory_items_product_type_valid check (
    product_type is null
    or (pg_catalog.btrim(product_type) <> '' and pg_catalog.char_length(product_type) <= 100)
  );

create table public.quotations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  reference_no text not null unique,
  quotation_no text not null,
  quotation_date date not null,
  valid_until date not null,
  customer_name text not null,
  customer_phone text,
  customer_email text,
  customer_address text,
  subtotal numeric(20,2) not null,
  discount_total numeric(20,2) not null default 0,
  total_amount numeric(20,2) not null,
  status text not null default 'draft',
  terms text,
  notes text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  constraint quotations_number_not_blank check (pg_catalog.btrim(quotation_no) <> ''),
  constraint quotations_reference_not_blank check (pg_catalog.btrim(reference_no) <> ''),
  constraint quotations_customer_not_blank check (pg_catalog.btrim(customer_name) <> ''),
  constraint quotations_dates_valid check (valid_until >= quotation_date),
  constraint quotations_amounts_valid check (
    subtotal > 0
    and discount_total >= 0
    and discount_total < subtotal
    and total_amount = subtotal - discount_total
  ),
  constraint quotations_status_valid check (
    status in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled')
  ),
  unique (company_id, quotation_no)
);

create table public.quotation_items (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  quotation_id uuid not null references public.quotations(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  product_name text not null,
  product_type text,
  quantity numeric(20,6) not null,
  unit_price numeric(20,2) not null,
  discount numeric(20,2) not null default 0,
  line_total numeric(20,2) generated always as (
    pg_catalog.round(quantity * unit_price - discount, 2)
  ) stored,
  notes text,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  constraint quotation_items_product_not_blank check (pg_catalog.btrim(product_name) <> ''),
  constraint quotation_items_values_valid check (
    quantity > 0 and unit_price > 0 and discount >= 0
    and discount < quantity * unit_price
  ),
  unique (quotation_id, item_id)
);

create index quotations_company_date_idx
  on public.quotations (company_id, quotation_date desc, id desc);
create index quotations_company_status_idx
  on public.quotations (company_id, status, valid_until, id);
create index quotations_company_customer_idx
  on public.quotations (company_id, pg_catalog.lower(customer_name), quotation_date desc);
create index quotation_items_quotation_idx
  on public.quotation_items (company_id, quotation_id, id);
create index quotation_items_item_idx
  on public.quotation_items (item_id, quotation_id);

create trigger quotations_rpc_guard
before insert or update or delete on public.quotations
for each row execute function private.require_rpc_guard();

create trigger quotation_items_rpc_guard
before insert or update or delete on public.quotation_items
for each row execute function private.require_rpc_guard();

create trigger quotations_company_context
before insert or update on public.quotations
for each row execute function private.enforce_company_context();

create trigger quotation_items_company_context
before insert or update on public.quotation_items
for each row execute function private.enforce_company_context();

create trigger quotation_items_quotation_company_parent
before insert or update on public.quotation_items
for each row execute function private.assert_company_parent('quotation_id', 'quotations', 'id');

create trigger quotations_finite_numbers
before insert or update on public.quotations
for each row execute function private.reject_non_finite_columns(
  'subtotal', 'discount_total', 'total_amount'
);

create trigger quotation_items_finite_numbers
before insert or update on public.quotation_items
for each row execute function private.reject_non_finite_columns(
  'quantity', 'unit_price', 'discount', 'line_total'
);

alter table public.quotations enable row level security;
alter table public.quotation_items enable row level security;

create policy erp_read on public.quotations
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['sales.read', 'reports.read']::text[]
));

create policy erp_read on public.quotation_items
for select to authenticated
using (private.has_company_any_permission(
  company_id,
  array['sales.read', 'reports.read']::text[]
));

revoke all on table public.quotations, public.quotation_items
from public, anon, authenticated;
grant select on table public.quotations, public.quotation_items
to authenticated;

create or replace view public.inventory_position
with (security_invoker = true)
as
select
  i.id as item_id,
  i.sku,
  i.name as item_name,
  i.stage,
  i.unit,
  coalesce(b.quantity_on_hand, 0::numeric)::numeric(20,6) as quantity_on_hand,
  coalesce(b.inventory_value, 0::numeric)::numeric(20,2) as inventory_value,
  case when coalesce(b.quantity_on_hand, 0) = 0 then 0::numeric
       else pg_catalog.round(b.inventory_value / b.quantity_on_hand, 6)
  end::numeric(20,6) as average_unit_cost,
  b.last_movement_at,
  i.is_active,
  i.selling_price,
  i.product_type
from public.inventory_items i
left join public.inventory_balances b on b.item_id = i.id;

create or replace view public.company_inventory_position
with (security_invoker = true)
as
select
  c.id as company_id,
  i.id as item_id,
  i.sku,
  i.name as item_name,
  i.stage,
  i.unit,
  coalesce(cb.quantity_on_hand, 0::numeric)::numeric(20,6) as quantity_on_hand,
  coalesce(b.quantity_on_hand, 0::numeric)::numeric(20,6) as shared_quantity_on_hand,
  coalesce(cb.inventory_value, 0::numeric)::numeric(20,2) as inventory_value,
  case
    when coalesce(cb.quantity_on_hand, 0) = 0 then 0::numeric
    else pg_catalog.round(cb.inventory_value / cb.quantity_on_hand, 6)
  end::numeric(20,6) as average_unit_cost,
  cb.last_movement_at,
  b.last_movement_at as shared_last_movement_at,
  i.is_active,
  i.selling_price,
  i.product_type
from public.companies c
cross join public.inventory_items i
left join public.company_inventory_balances cb
  on cb.company_id = c.id and cb.item_id = i.id
left join public.inventory_balances b on b.item_id = i.id
where c.is_active;

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_product_quotations;

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
  v_result jsonb;
  v_id uuid;
  v_item_id uuid;
  v_item_ids uuid[] := array[]::uuid[];
  v_reference text;
  v_number text;
  v_name text;
  v_type text;
  v_sku text;
  v_customer text;
  v_status text;
  v_date date;
  v_valid_until date;
  v_price numeric(20,2);
  v_quantity numeric(20,6);
  v_discount numeric(20,2);
  v_line_gross numeric(20,2);
  v_subtotal numeric(20,2) := 0;
  v_discount_total numeric(20,2) := 0;
  v_total numeric(20,2) := 0;
  v_input jsonb;
  v_row record;
begin
  if p_operation in (
    'product.upsert', 'production.post',
    'quotation.upsert', 'quotation.cancel', 'system.purge_business_data'
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

  if p_operation = 'product.upsert' then
    perform private.assert_permission('production.write');
    v_name := nullif(pg_catalog.btrim(p_payload ->> 'name'), '');
    v_type := nullif(pg_catalog.btrim(p_payload ->> 'product_type'), '');
    v_price := pg_catalog.round((p_payload ->> 'selling_price')::numeric, 2);
    v_sku := nullif(pg_catalog.upper(pg_catalog.btrim(p_payload ->> 'sku')), '');
    if v_name is null or pg_catalog.char_length(v_name) > 160 then
      raise exception using errcode = '22023', message = 'Product name is required and must be 160 characters or fewer';
    end if;
    if v_type is null or pg_catalog.char_length(v_type) > 100 then
      raise exception using errcode = '22023', message = 'Product type is required and must be 100 characters or fewer';
    end if;
    if v_price <= 0 or v_price::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '22023', message = 'Selling price must be greater than zero';
    end if;
    if v_sku is not null and pg_catalog.char_length(v_sku) > 80 then
      raise exception using errcode = '22023', message = 'SKU must be 80 characters or fewer';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('finished-product:' || pg_catalog.lower(v_name), 0)
    );
    if nullif(p_payload ->> 'id', '') is null then
      if exists (
        select 1 from public.inventory_items i
        where i.stage = 'finished' and pg_catalog.lower(i.name) = pg_catalog.lower(v_name)
      ) then
        raise exception using errcode = '23505', message = 'A finished product with this name already exists';
      end if;
      v_id := pg_catalog.gen_random_uuid();
      insert into public.inventory_items (
        id, sku, name, stage, unit, product_type, selling_price,
        is_active, created_by, updated_by
      ) values (
        v_id,
        coalesce(v_sku, 'FIN-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(v_id::text, '-', ''), 1, 12))),
        v_name, 'finished', 'unit', v_type, v_price,
        coalesce((p_payload ->> 'is_active')::boolean, true), p_actor, p_actor
      );
      insert into public.inventory_balances (item_id) values (v_id)
      on conflict (item_id) do nothing;
    else
      v_id := (p_payload ->> 'id')::uuid;
      update public.inventory_items
      set name = v_name,
          sku = coalesce(v_sku, sku),
          product_type = v_type,
          selling_price = v_price,
          is_active = coalesce((p_payload ->> 'is_active')::boolean, is_active),
          updated_at = pg_catalog.clock_timestamp(),
          updated_by = p_actor
      where id = v_id and stage = 'finished';
      if not found then
        raise exception using errcode = 'P0001', message = 'Finished product not found';
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', coalesce(v_sku, v_id::text), 'idempotent', false
    );

  elsif p_operation = 'production.post' then
    v_result := private.perform_operation_before_product_quotations(
      p_operation, p_payload, p_actor
    );
    v_id := (v_result ->> 'id')::uuid;
    v_type := nullif(pg_catalog.btrim(p_payload ->> 'product_type'), '');
    if v_type is not null then
      if pg_catalog.char_length(v_type) > 100 then
        raise exception using errcode = '22023', message = 'Product type must be 100 characters or fewer';
      end if;
      select pr.finished_item_id into v_item_id
      from public.production_runs pr
      where pr.id = v_id and pr.company_id = v_company_id;
      update public.inventory_items
      set product_type = v_type,
          updated_at = pg_catalog.clock_timestamp(),
          updated_by = p_actor
      where id = v_item_id and stage = 'finished';
    end if;
    return v_result;

  elsif p_operation = 'quotation.upsert' then
    perform private.assert_permission('sales.write');
    v_date := (p_payload ->> 'quotation_date')::date;
    v_valid_until := (p_payload ->> 'valid_until')::date;
    v_customer := nullif(pg_catalog.btrim(p_payload ->> 'customer_name'), '');
    v_status := coalesce(nullif(pg_catalog.lower(pg_catalog.btrim(p_payload ->> 'status')), ''), 'draft');
    if v_valid_until < v_date then
      raise exception using errcode = '22023', message = 'Quotation valid-until date cannot be before its quotation date';
    end if;
    if v_customer is null or pg_catalog.char_length(v_customer) > 160 then
      raise exception using errcode = '22023', message = 'Customer name is required and must be 160 characters or fewer';
    end if;
    if v_status not in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled') then
      raise exception using errcode = '22023', message = 'Invalid quotation status';
    end if;
    v_input := coalesce(p_payload -> 'items', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_input) <> 'array'
       or pg_catalog.jsonb_array_length(v_input) not between 1 and 100 then
      raise exception using errcode = '22023', message = 'A quotation requires between 1 and 100 items';
    end if;

    if nullif(p_payload ->> 'id', '') is null then
      v_id := pg_catalog.gen_random_uuid();
      v_reference := private.new_reference('QUO');
      v_number := coalesce(
        nullif(pg_catalog.btrim(p_payload ->> 'quotation_no'), ''), v_reference
      );
      insert into public.quotations (
        id, company_id, reference_no, quotation_no, quotation_date, valid_until,
        customer_name, customer_phone, customer_email, customer_address,
        subtotal, discount_total, total_amount, status, terms, notes,
        created_by, updated_by
      ) values (
        v_id, v_company_id, v_reference, pg_catalog.left(v_number, 80),
        v_date, v_valid_until, v_customer,
        nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'customer_phone'), 40), ''),
        nullif(pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(p_payload ->> 'customer_email')), 254), ''),
        nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'customer_address'), 500), ''),
        1, 0, 1, v_status,
        nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'terms'), 4000), ''),
        nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'notes'), 4000), ''),
        p_actor, p_actor
      );
    else
      v_id := (p_payload ->> 'id')::uuid;
      select q.reference_no, q.quotation_no into v_reference, v_number
      from public.quotations q
      where q.id = v_id and q.company_id = v_company_id
      for update;
      if not found then
        raise exception using errcode = 'P0001', message = 'Quotation not found';
      end if;
      v_number := coalesce(
        nullif(pg_catalog.btrim(p_payload ->> 'quotation_no'), ''), v_number
      );
      delete from public.quotation_items qi
      where qi.quotation_id = v_id and qi.company_id = v_company_id;
    end if;

    for v_row in
      select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
    loop
      v_item_id := (v_row.value ->> 'item_id')::uuid;
      if pg_catalog.array_position(v_item_ids, v_item_id) is not null then
        raise exception using errcode = '23514', message = 'A quotation cannot contain the same product twice';
      end if;
      v_item_ids := pg_catalog.array_append(v_item_ids, v_item_id);
      select i.name, i.product_type into v_name, v_type
      from public.inventory_items i
      where i.id = v_item_id and i.stage = 'finished' and i.is_active;
      if not found then
        raise exception using errcode = 'P0001', message = 'Active finished product not found';
      end if;
      v_quantity := pg_catalog.round((v_row.value ->> 'quantity')::numeric, 6);
      v_price := pg_catalog.round((v_row.value ->> 'unit_price')::numeric, 2);
      v_discount := pg_catalog.round(
        coalesce(nullif(v_row.value ->> 'discount', '')::numeric, 0), 2
      );
      if v_quantity <= 0 or v_price <= 0 or v_discount < 0
         or v_quantity::text in ('NaN', 'Infinity', '-Infinity')
         or v_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_discount::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception using errcode = '22023', message = 'Invalid quotation quantity, price, or discount';
      end if;
      v_line_gross := pg_catalog.round(v_quantity * v_price, 2);
      if v_discount >= v_line_gross then
        raise exception using errcode = '23514', message = 'Quotation line discount must be less than its gross amount';
      end if;
      v_subtotal := v_subtotal + v_line_gross;
      v_discount_total := v_discount_total + v_discount;
      insert into public.quotation_items (
        company_id, quotation_id, item_id, product_name, product_type,
        quantity, unit_price, discount, notes, created_by
      ) values (
        v_company_id, v_id, v_item_id, v_name, v_type,
        v_quantity, v_price, v_discount,
        nullif(pg_catalog.left(pg_catalog.btrim(v_row.value ->> 'notes'), 500), ''),
        p_actor
      );
    end loop;
    v_subtotal := pg_catalog.round(v_subtotal, 2);
    v_discount_total := pg_catalog.round(v_discount_total, 2);
    v_total := v_subtotal - v_discount_total;
    update public.quotations
    set quotation_no = pg_catalog.left(v_number, 80),
        quotation_date = v_date,
        valid_until = v_valid_until,
        customer_name = v_customer,
        customer_phone = nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'customer_phone'), 40), ''),
        customer_email = nullif(pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(p_payload ->> 'customer_email')), 254), ''),
        customer_address = nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'customer_address'), 500), ''),
        subtotal = v_subtotal,
        discount_total = v_discount_total,
        total_amount = v_total,
        status = v_status,
        terms = nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'terms'), 4000), ''),
        notes = nullif(pg_catalog.left(pg_catalog.btrim(p_payload ->> 'notes'), 4000), ''),
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_number, 'idempotent', false
    );

  elsif p_operation = 'quotation.cancel' then
    perform private.assert_permission('sales.write');
    v_id := (p_payload ->> 'id')::uuid;
    update public.quotations
    set status = 'cancelled',
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id and status <> 'cancelled';
    if not found then
      raise exception using errcode = 'P0001', message = 'Active quotation not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_id::text, 'idempotent', false
    );

  elsif p_operation = 'system.purge_business_data' then
    delete from public.quotation_items where company_id = v_company_id;
    delete from public.quotations where company_id = v_company_id;
    return private.perform_operation_before_product_quotations(
      p_operation, p_payload, p_actor
    );
  end if;

  return private.perform_operation_before_product_quotations(
    p_operation, p_payload, p_actor
  );
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
