begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- A partner website receives only this deliberately sanitized document. The
-- catalogue id is an unguessable, revocable public share id; it is not an ERP
-- credential and it cannot be used to read any other table or perform writes.
create function public.erp_public_website_catalog(p_catalog_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'api_version', '1.0',
    'catalog_id', credential.public_id,
    'generated_at', pg_catalog.statement_timestamp(),
    'company', pg_catalog.jsonb_build_object(
      'code', company.code,
      'name', company.name,
      'address', company.address,
      'phone', company.phone,
      'email', company.email,
      'logo_url', company.logo_url
    ),
    'items', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', item.id,
          'sku', item.sku,
          'name', item.name,
          'category', item.product_type,
          'image_url', item.image_url,
          'selling_price', item.selling_price,
          'description', item.description,
          'unit', item.unit,
          'updated_at', item.updated_at
        )
        order by item.product_type, item.name, item.id
      )
      from public.inventory_items item
      where item.stage = 'finished'
        and item.is_active
        and item.selling_price > 0
    ), '[]'::jsonb)
  )
  from public.catalog_api_credentials credential
  join public.companies company
    on company.id = credential.company_id
   and company.is_active
  where credential.public_id = p_catalog_id
    and credential.status = 'active';
$function$;

revoke all on function public.erp_public_website_catalog(uuid)
from public, anon, authenticated;
grant execute on function public.erp_public_website_catalog(uuid)
to service_role;

commit;
