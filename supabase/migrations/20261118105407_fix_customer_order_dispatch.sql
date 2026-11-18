begin;

-- The ERP facade dispatches through perform_operation_v2.  The initial
-- customer-order migration wrapped the older dispatcher, so these operations
-- never reached its new branches.  Wrap the active dispatcher in place while
-- retaining the earlier implementation as the fallback.
alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_v2_before_customer_order_dispatch;

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

    v_result := private.perform_operation_v2_before_customer_order_dispatch(
      p_operation, p_payload, p_actor
    );
    v_id := (v_result ->> 'id')::uuid;
    update public.inventory_items
    set description = v_description,
        image_url = v_image_url,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_id and stage = 'finished';
    if not found then
      raise exception using errcode = 'P0001', message = 'Finished product not found';
    end if;
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
  end if;

  return private.perform_operation_v2_before_customer_order_dispatch(
    p_operation, p_payload, p_actor
  );
end;
$function$;

revoke all on function private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
