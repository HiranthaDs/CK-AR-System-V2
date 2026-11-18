-- Product presentation media plus a stock-free public catalogue and customer
-- order inbox. Anonymous visitors never receive inventory balances or costs.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

alter table public.inventory_items
  add column description text,
  add column image_url text,
  add constraint inventory_items_description_valid check (
    description is null or pg_catalog.char_length(description) <= 2000
  ),
  add constraint inventory_items_image_url_valid check (
    image_url is null
    or (
      pg_catalog.char_length(image_url) <= 1000
      and image_url ~ '^https://'
    )
  );

create table public.customer_orders (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  order_no text not null,
  tracking_token uuid not null default pg_catalog.gen_random_uuid(),
  request_key text not null,
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  customer_address text,
  notes text,
  status text not null default 'pending',
  subtotal numeric(20,2) not null default 0,
  total_amount numeric(20,2) not null default 0,
  source text not null default 'catalogue',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  status_updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint customer_orders_order_no_not_blank check (pg_catalog.btrim(order_no) <> ''),
  constraint customer_orders_request_key_valid check (
    pg_catalog.char_length(request_key) between 16 and 200
  ),
  constraint customer_orders_customer_name_valid check (
    pg_catalog.btrim(customer_name) <> '' and pg_catalog.char_length(customer_name) <= 160
  ),
  constraint customer_orders_customer_phone_valid check (
    pg_catalog.btrim(customer_phone) <> '' and pg_catalog.char_length(customer_phone) <= 40
  ),
  constraint customer_orders_customer_email_valid check (
    customer_email is null or pg_catalog.char_length(customer_email) <= 254
  ),
  constraint customer_orders_customer_address_valid check (
    customer_address is null or pg_catalog.char_length(customer_address) <= 500
  ),
  constraint customer_orders_notes_valid check (
    notes is null or pg_catalog.char_length(notes) <= 2000
  ),
  constraint customer_orders_status_valid check (
    status in ('pending', 'confirmed', 'in_progress', 'ready', 'completed', 'cancelled')
  ),
  constraint customer_orders_amounts_valid check (
    subtotal >= 0 and total_amount >= 0 and total_amount = subtotal
  ),
  constraint customer_orders_source_valid check (source in ('catalogue', 'staff')),
  unique (company_id, order_no),
  unique (tracking_token),
  unique (request_key)
);

create table public.customer_order_items (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  product_name text not null,
  product_category text not null,
  product_image_url text,
  product_description text,
  quantity numeric(20,6) not null,
  unit_price numeric(20,2) not null,
  line_total numeric(20,2) generated always as (
    pg_catalog.round(quantity * unit_price, 2)
  ) stored,
  created_at timestamptz not null default pg_catalog.now(),
  constraint customer_order_items_product_name_valid check (
    pg_catalog.btrim(product_name) <> '' and pg_catalog.char_length(product_name) <= 160
  ),
  constraint customer_order_items_category_valid check (
    pg_catalog.btrim(product_category) <> '' and pg_catalog.char_length(product_category) <= 100
  ),
  constraint customer_order_items_values_valid check (
    quantity > 0 and quantity <= 10000 and unit_price > 0
  ),
  unique (order_id, item_id)
);

create index customer_orders_company_status_created_idx
  on public.customer_orders (company_id, status, created_at desc, id);
create index customer_orders_company_created_idx
  on public.customer_orders (company_id, created_at desc, id);
create index customer_orders_company_customer_idx
  on public.customer_orders (company_id, pg_catalog.lower(customer_name), created_at desc);
create index customer_order_items_order_idx
  on public.customer_order_items (order_id, id);
create index customer_order_items_item_idx
  on public.customer_order_items (item_id, order_id);

alter table public.customer_orders enable row level security;
alter table public.customer_order_items enable row level security;

create policy erp_read on public.customer_orders
for select to authenticated
using (
  private.has_company_any_permission(
    company_id,
    array['sales.read', 'sales.write']::text[]
  )
);

create policy erp_read on public.customer_order_items
for select to authenticated
using (
  private.has_company_any_permission(
    company_id,
    array['sales.read', 'sales.write']::text[]
  )
);

revoke all on table public.customer_orders, public.customer_order_items
from public, anon, authenticated, service_role;
grant select on table public.customer_orders, public.customer_order_items
to authenticated;

-- Product images are public catalogue assets. Only authorized ERP users can
-- upload or modify them; a public bucket makes only the final asset URL public.
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists product_images_insert on storage.objects;
create policy product_images_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'product-images'
  and private.has_permission('production.write')
);

drop policy if exists product_images_select on storage.objects;
create policy product_images_select on storage.objects
for select to authenticated
using (
  bucket_id = 'product-images'
  and private.has_permission('production.write')
);

drop policy if exists product_images_update on storage.objects;
create policy product_images_update on storage.objects
for update to authenticated
using (
  bucket_id = 'product-images'
  and private.has_permission('production.write')
)
with check (
  bucket_id = 'product-images'
  and private.has_permission('production.write')
);

drop policy if exists product_images_delete on storage.objects;
create policy product_images_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'product-images'
  and private.has_permission('production.write')
);

-- Server-only, sanitized catalogue endpoint. The service role can invoke this
-- from the Python API; browser roles cannot call it directly.
create or replace function public.erp_public_catalog()
returns table (
  id uuid,
  sku text,
  name text,
  category text,
  image_url text,
  selling_price numeric(20,2),
  description text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    i.id,
    i.sku,
    i.name,
    i.product_type,
    i.image_url,
    i.selling_price,
    i.description
  from public.inventory_items i
  where i.stage = 'finished'
    and i.is_active
    and i.selling_price > 0
  order by i.product_type, i.name, i.id;
$function$;

revoke all on function public.erp_public_catalog()
from public, anon, authenticated;
grant execute on function public.erp_public_catalog() to service_role;

create or replace function public.erp_submit_public_order(
  p_payload jsonb,
  p_request_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
  v_order_id uuid;
  v_order_no text;
  v_tracking_token uuid;
  v_customer_name text;
  v_customer_phone text;
  v_customer_email text;
  v_customer_address text;
  v_notes text;
  v_items jsonb;
  v_item_ids uuid[] := array[]::uuid[];
  v_item_id uuid;
  v_name text;
  v_category text;
  v_image_url text;
  v_description text;
  v_quantity numeric(20,6);
  v_price numeric(20,2);
  v_total numeric(20,2) := 0;
  v_row record;
  v_existing record;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Order payload must be a JSON object';
  end if;
  if p_request_key is null
     or pg_catalog.char_length(p_request_key) not between 16 and 200 then
    raise exception using errcode = '22023', message = 'A valid request key is required';
  end if;

  select o.order_no, o.tracking_token, o.status, o.total_amount
  into v_existing
  from public.customer_orders o
  where o.request_key = p_request_key;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'order_no', v_existing.order_no,
      'tracking_token', v_existing.tracking_token,
      'status', v_existing.status,
      'total_amount', v_existing.total_amount,
      'idempotent', true
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public-order:' || p_request_key, 0)
  );

  select o.order_no, o.tracking_token, o.status, o.total_amount
  into v_existing
  from public.customer_orders o
  where o.request_key = p_request_key;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'order_no', v_existing.order_no,
      'tracking_token', v_existing.tracking_token,
      'status', v_existing.status,
      'total_amount', v_existing.total_amount,
      'idempotent', true
    );
  end if;

  v_customer_name := nullif(pg_catalog.btrim(p_payload ->> 'customer_name'), '');
  v_customer_phone := nullif(pg_catalog.btrim(p_payload ->> 'customer_phone'), '');
  v_customer_email := nullif(pg_catalog.lower(pg_catalog.btrim(p_payload ->> 'customer_email')), '');
  v_customer_address := nullif(pg_catalog.btrim(p_payload ->> 'customer_address'), '');
  v_notes := nullif(pg_catalog.btrim(p_payload ->> 'notes'), '');
  v_items := coalesce(p_payload -> 'items', '[]'::jsonb);

  if v_customer_name is null or pg_catalog.char_length(v_customer_name) > 160 then
    raise exception using errcode = '22023', message = 'Customer name is required and must be 160 characters or fewer';
  end if;
  if v_customer_phone is null or pg_catalog.char_length(v_customer_phone) > 40 then
    raise exception using errcode = '22023', message = 'Customer phone is required and must be 40 characters or fewer';
  end if;
  if v_customer_email is not null and (
    pg_catalog.char_length(v_customer_email) > 254
    or v_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ) then
    raise exception using errcode = '22023', message = 'Customer email is invalid';
  end if;
  if v_customer_address is not null and pg_catalog.char_length(v_customer_address) > 500 then
    raise exception using errcode = '22023', message = 'Customer address must be 500 characters or fewer';
  end if;
  if v_notes is not null and pg_catalog.char_length(v_notes) > 2000 then
    raise exception using errcode = '22023', message = 'Order notes must be 2000 characters or fewer';
  end if;
  if pg_catalog.jsonb_typeof(v_items) <> 'array'
     or pg_catalog.jsonb_array_length(v_items) not between 1 and 50 then
    raise exception using errcode = '22023', message = 'An order requires between 1 and 50 products';
  end if;

  select c.id into v_company_id
  from public.companies c
  where c.code = 'CK' and c.is_active;
  if v_company_id is null then
    raise exception using errcode = 'P0001', message = 'The CK company portal is unavailable';
  end if;

  v_order_id := pg_catalog.gen_random_uuid();
  v_tracking_token := pg_catalog.gen_random_uuid();
  v_order_no := private.new_reference('ORD');

  insert into public.customer_orders (
    id, company_id, order_no, tracking_token, request_key,
    customer_name, customer_phone, customer_email, customer_address,
    notes, status, subtotal, total_amount, source
  ) values (
    v_order_id, v_company_id, v_order_no, v_tracking_token, p_request_key,
    v_customer_name, v_customer_phone, v_customer_email, v_customer_address,
    v_notes, 'pending', 0, 0, 'catalogue'
  );

  for v_row in
    select x.value from pg_catalog.jsonb_array_elements(v_items) x(value)
  loop
    begin
      v_item_id := (v_row.value ->> 'item_id')::uuid;
      v_quantity := pg_catalog.round((v_row.value ->> 'quantity')::numeric, 6);
    exception when others then
      raise exception using errcode = '22023', message = 'Each order item requires a valid product and quantity';
    end;

    if pg_catalog.array_position(v_item_ids, v_item_id) is not null then
      raise exception using errcode = '23514', message = 'An order cannot contain the same product twice';
    end if;
    v_item_ids := pg_catalog.array_append(v_item_ids, v_item_id);
    if v_quantity <= 0 or v_quantity > 10000
       or v_quantity::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '22023', message = 'Order quantity must be between 0 and 10000';
    end if;

    select
      i.name, i.product_type, i.image_url, i.description,
      pg_catalog.round(i.selling_price, 2)
    into v_name, v_category, v_image_url, v_description, v_price
    from public.inventory_items i
    where i.id = v_item_id
      and i.stage = 'finished'
      and i.is_active
      and i.selling_price > 0;
    if not found then
      raise exception using errcode = 'P0001', message = 'A selected product is no longer available';
    end if;

    insert into public.customer_order_items (
      company_id, order_id, item_id, product_name, product_category,
      product_image_url, product_description, quantity, unit_price
    ) values (
      v_company_id, v_order_id, v_item_id, v_name, v_category,
      v_image_url, v_description, v_quantity, v_price
    );
    v_total := v_total + pg_catalog.round(v_quantity * v_price, 2);
  end loop;

  v_total := pg_catalog.round(v_total, 2);
  update public.customer_orders
  set subtotal = v_total,
      total_amount = v_total,
      updated_at = pg_catalog.clock_timestamp()
  where id = v_order_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'order_no', v_order_no,
    'tracking_token', v_tracking_token,
    'status', 'pending',
    'total_amount', v_total,
    'idempotent', false
  );
end;
$function$;

revoke all on function public.erp_submit_public_order(jsonb, text)
from public, anon, authenticated;
grant execute on function public.erp_submit_public_order(jsonb, text)
to service_role;

-- Extend the guarded ERP dispatcher for product presentation fields, product
-- reversal, and staff-managed customer-order status changes.
alter function private.perform_operation(text, jsonb, uuid)
  rename to perform_operation_before_customer_orders;

create or replace function private.perform_operation(
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
  v_description text;
  v_image_url text;
  v_status text;
begin
  if p_operation in ('product.reverse', 'customer_order.status') then
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
    v_description := nullif(pg_catalog.btrim(p_payload ->> 'description'), '');
    v_image_url := nullif(pg_catalog.btrim(p_payload ->> 'image_url'), '');
    if v_description is not null and pg_catalog.char_length(v_description) > 2000 then
      raise exception using errcode = '22023', message = 'Product description must be 2000 characters or fewer';
    end if;
    if v_image_url is not null and (
      pg_catalog.char_length(v_image_url) > 1000 or v_image_url !~ '^https://'
    ) then
      raise exception using errcode = '22023', message = 'Product image URL is invalid';
    end if;
    v_result := private.perform_operation_before_customer_orders(
      p_operation, p_payload, p_actor
    );
    v_id := (v_result ->> 'id')::uuid;
    update public.inventory_items
    set description = v_description,
        image_url = v_image_url,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and stage = 'finished';
    return v_result;

  elsif p_operation = 'product.reverse' then
    perform private.assert_permission('production.write');
    v_id := (p_payload ->> 'id')::uuid;
    update public.inventory_items
    set is_active = false,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and stage = 'finished' and is_active;
    if not found then
      raise exception using errcode = 'P0001', message = 'Active finished product not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_id::text, 'idempotent', false
    );

  elsif p_operation = 'customer_order.status' then
    perform private.assert_permission('sales.write');
    v_id := (p_payload ->> 'id')::uuid;
    v_status := pg_catalog.lower(pg_catalog.btrim(p_payload ->> 'status'));
    if v_status not in ('pending', 'confirmed', 'in_progress', 'ready', 'completed', 'cancelled') then
      raise exception using errcode = '22023', message = 'Invalid customer order status';
    end if;
    update public.customer_orders
    set status = v_status,
        status_updated_at = case when status is distinct from v_status
          then pg_catalog.clock_timestamp() else status_updated_at end,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'Customer order not found';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'operation', p_operation, 'id', v_id,
      'reference_no', v_id::text, 'idempotent', false
    );

  elsif p_operation = 'system.purge_business_data' then
    delete from public.customer_order_items where company_id = v_company_id;
    delete from public.customer_orders where company_id = v_company_id;
    return private.perform_operation_before_customer_orders(
      p_operation, p_payload, p_actor
    );
  end if;

  return private.perform_operation_before_customer_orders(
    p_operation, p_payload, p_actor
  );
end;
$function$;

revoke all on function private.perform_operation(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
