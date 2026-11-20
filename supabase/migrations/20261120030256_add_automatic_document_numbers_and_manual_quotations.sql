-- Automatic, concurrency-safe customer document numbers, manual quotation
-- lines, and a separate customer-facing invoice lifecycle status.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local app.erp_rpc_guard = 'enabled';

alter table public.quotation_items
  alter column item_id drop not null;

alter table public.quotations
  add column if not exists payment_method text not null default 'accounts_receivable';

do $constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'quotations_payment_method_valid'
      and conrelid = 'public.quotations'::pg_catalog.regclass
  ) then
    alter table public.quotations
      add constraint quotations_payment_method_valid
      check (payment_method in ('cash', 'bank_transfer', 'cheque', 'credit', 'accounts_receivable', 'other'));
  end if;
end;
$constraint$;

alter table public.quotation_items
  drop constraint if exists quotation_items_quotation_id_item_id_key;

create unique index if not exists quotation_items_catalog_product_unique_idx
  on public.quotation_items (quotation_id, item_id)
  where item_id is not null;

alter table public.sales
  add column if not exists document_status text not null default 'issued';

do $constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'sales_document_status_valid'
      and conrelid = 'public.sales'::pg_catalog.regclass
  ) then
    alter table public.sales
      add constraint sales_document_status_valid
      check (document_status in ('issued', 'delivered', 'completed'));
  end if;
end;
$constraint$;

create index if not exists sales_company_document_status_date_idx
  on public.sales (company_id, document_status, sale_date desc, id desc)
  where status = 'posted';

-- Populate the requested CK invoice identity while retaining the editable
-- company-profile workflow for future changes.
update public.companies
set name = 'CK Plastic',
    address = 'No. 242/A, Gorokgoda, Millewa, Harana, Sri Lanka.',
    phone = '0774881490 / 0712374024',
    email = 'info@ckplasticsl.com',
    updated_at = pg_catalog.clock_timestamp()
where code = 'CK';

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_v2_before_document_workflow;

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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_result jsonb;
  v_id uuid;
  v_target_id uuid;
  v_item_id uuid;
  v_item_ids uuid[] := array[]::uuid[];
  v_reference text;
  v_number text;
  v_prefix text;
  v_company_code text;
  v_name text;
  v_type text;
  v_customer text;
  v_status text;
  v_document_status text;
  v_method text;
  v_date date;
  v_valid_until date;
  v_sequence bigint;
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
  if p_operation not in ('sale.post', 'sale.replace', 'quotation.upsert') then
    return private.perform_operation_v2_before_document_workflow(
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

  if p_operation = 'sale.replace' then
    v_target_id := (v_payload #>> '{target,id}')::uuid;
    select s.invoice_no into v_number
    from public.sales s
    where s.id = v_target_id and s.company_id = v_company_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Sale not found';
    end if;
    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{replacement,invoice_no}',
      pg_catalog.to_jsonb(v_number),
      true
    );
    return private.perform_operation_v2_before_document_workflow(
      p_operation, v_payload, p_actor
    );
  end if;

  if p_operation = 'sale.post' then
    v_date := (v_payload ->> 'sale_date')::date;
    v_document_status := coalesce(
      nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'document_status')), ''),
      'issued'
    );
    if v_document_status not in ('issued', 'delivered', 'completed') then
      raise exception using errcode = '22023', message = 'Invalid invoice status';
    end if;

    -- Replacements keep the original number. New invoices receive the next
    -- number inside their own company/month lock, so concurrent saves cannot
    -- choose the same sequence.
    if nullif(v_payload ->> '_replaces_id', '') is null then
      select case when c.code = 'CK' then 'CK' else pg_catalog.upper(c.code) end
      into v_company_code
      from public.companies c
      where c.id = v_company_id;
      v_prefix := v_company_code || '-INV-' || pg_catalog.to_char(v_date, 'YYYYMM') || '-';
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('sales-invoice:' || v_company_id::text || ':' || v_prefix, 0)
      );
      select coalesce(pg_catalog.max(
        pg_catalog.substring(s.invoice_no from '([0-9]+)$')::bigint
      ), 0) + 1
      into v_sequence
      from public.sales s
      where s.company_id = v_company_id
        and s.invoice_no like v_prefix || '%'
        and s.invoice_no ~ ('^' || v_prefix || '[0-9]+$');
      v_number := v_prefix || pg_catalog.lpad(
        v_sequence::text,
        pg_catalog.greatest(4, pg_catalog.length(v_sequence::text)),
        '0'
      );
      v_payload := pg_catalog.jsonb_set(
        v_payload, '{invoice_no}', pg_catalog.to_jsonb(v_number), true
      );
    else
      v_number := nullif(pg_catalog.btrim(v_payload ->> 'invoice_no'), '');
      if v_number is null then
        raise exception using errcode = '22023', message = 'A replacement invoice must retain its invoice number';
      end if;
    end if;

    v_result := private.perform_operation_v2_before_document_workflow(
      p_operation, v_payload, p_actor
    );
    v_id := (v_result ->> 'id')::uuid;
    update public.sales
    set document_status = v_document_status,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and company_id = v_company_id;
    return v_result || pg_catalog.jsonb_build_object('invoice_no', v_number);
  end if;

  -- Quotations do not post stock or accounting. Catalogue lines snapshot the
  -- current product name/type; manual lines retain the user's supplied text.
  perform private.assert_permission('sales.write');
  v_date := (v_payload ->> 'quotation_date')::date;
  v_valid_until := (v_payload ->> 'valid_until')::date;
  v_customer := nullif(pg_catalog.btrim(v_payload ->> 'customer_name'), '');
  v_status := coalesce(
    nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'status')), ''),
    'draft'
  );
  v_method := coalesce(
    nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'payment_method')), ''),
    'accounts_receivable'
  );
  if v_valid_until < v_date then
    raise exception using errcode = '22023', message = 'Quotation valid-until date cannot be before its quotation date';
  end if;
  if v_customer is null or pg_catalog.char_length(v_customer) > 160 then
    raise exception using errcode = '22023', message = 'Customer name is required and must be 160 characters or fewer';
  end if;
  if v_status not in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled') then
    raise exception using errcode = '22023', message = 'Invalid quotation status';
  end if;
  if v_method not in ('cash', 'bank_transfer', 'cheque', 'credit', 'accounts_receivable', 'other') then
    raise exception using errcode = '22023', message = 'Invalid quotation payment method';
  end if;
  v_input := coalesce(v_payload -> 'items', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_input) <> 'array'
     or pg_catalog.jsonb_array_length(v_input) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'A quotation requires between 1 and 100 items';
  end if;

  if nullif(v_payload ->> 'id', '') is null then
    v_id := pg_catalog.gen_random_uuid();
    v_reference := private.new_reference('QUO');
    select pg_catalog.upper(c.code) into v_company_code
    from public.companies c
    where c.id = v_company_id;
    v_company_code := case
      when v_company_code = 'CK' then 'CKP'
      when v_company_code = 'AR' then 'ARP'
      else pg_catalog.regexp_replace(v_company_code, '[^A-Z0-9]', '', 'g')
    end;
    v_prefix := 'QT-' || v_company_code || '-';
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('quotation:' || v_company_id::text, 0)
    );
    select coalesce(pg_catalog.max(
      pg_catalog.substring(q.quotation_no from '([0-9]+)$')::bigint
    ), 0) + 1
    into v_sequence
    from public.quotations q
    where q.company_id = v_company_id
      and q.quotation_no like v_prefix || '%'
      and q.quotation_no ~ ('^' || v_prefix || '[0-9]+$');
    v_number := v_prefix || pg_catalog.lpad(
      v_sequence::text,
      pg_catalog.greatest(4, pg_catalog.length(v_sequence::text)),
      '0'
    );
    insert into public.quotations (
      id, company_id, reference_no, quotation_no, quotation_date, valid_until,
      customer_name, customer_phone, customer_email, customer_address, payment_method,
      subtotal, discount_total, total_amount, status, terms, notes,
      created_by, updated_by
    ) values (
      v_id, v_company_id, v_reference, v_number, v_date, v_valid_until,
      v_customer,
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'customer_phone'), 40), ''),
      nullif(pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'customer_email')), 254), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'customer_address'), 500), ''), v_method,
      1, 0, 1, v_status,
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'terms'), 4000), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 4000), ''),
      p_actor, p_actor
    );
  else
    v_id := (v_payload ->> 'id')::uuid;
    select q.reference_no, q.quotation_no into v_reference, v_number
    from public.quotations q
    where q.id = v_id and q.company_id = v_company_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'Quotation not found';
    end if;
    delete from public.quotation_items qi
    where qi.quotation_id = v_id and qi.company_id = v_company_id;
  end if;

  for v_row in
    select x.value from pg_catalog.jsonb_array_elements(v_input) x(value)
  loop
    v_item_id := nullif(v_row.value ->> 'item_id', '')::uuid;
    if v_item_id is not null then
      if pg_catalog.array_position(v_item_ids, v_item_id) is not null then
        raise exception using errcode = '23514', message = 'A quotation cannot contain the same catalogue product twice';
      end if;
      v_item_ids := pg_catalog.array_append(v_item_ids, v_item_id);
      select i.name, i.product_type into v_name, v_type
      from public.inventory_items i
      where i.id = v_item_id and i.stage = 'finished' and i.is_active;
      if not found then
        raise exception using errcode = 'P0001', message = 'Active finished product not found';
      end if;
    else
      v_name := nullif(pg_catalog.btrim(v_row.value ->> 'product_name'), '');
      v_type := nullif(pg_catalog.btrim(v_row.value ->> 'product_type'), '');
      if v_name is null or pg_catalog.char_length(v_name) > 160 then
        raise exception using errcode = '22023', message = 'Manual product name is required and must be 160 characters or fewer';
      end if;
      if v_type is not null and pg_catalog.char_length(v_type) > 100 then
        raise exception using errcode = '22023', message = 'Manual product type must be 100 characters or fewer';
      end if;
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
  set quotation_date = v_date,
      valid_until = v_valid_until,
      customer_name = v_customer,
      customer_phone = nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'customer_phone'), 40), ''),
      customer_email = nullif(pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'customer_email')), 254), ''),
      customer_address = nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'customer_address'), 500), ''),
      payment_method = v_method,
      subtotal = v_subtotal,
      discount_total = v_discount_total,
      total_amount = v_total,
      status = v_status,
      terms = nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'terms'), 4000), ''),
      notes = nullif(pg_catalog.left(pg_catalog.btrim(v_payload ->> 'notes'), 4000), ''),
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor
  where id = v_id and company_id = v_company_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'operation', p_operation, 'id', v_id,
    'reference_no', v_number, 'quotation_no', v_number,
    'idempotent', false
  );
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

revoke all on function private.perform_operation_v2_before_document_workflow(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
