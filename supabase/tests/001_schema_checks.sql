-- Run after all migrations. This script is read-only and fails immediately
-- when the public ERP contract or its security boundary is incomplete.
begin;

do $checks$
declare
  v_name text;
  v_default text;
begin
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosrc like '%pg_catalog.current_date%'
  ) then
    raise exception 'ERP functions must not schema-qualify CURRENT_DATE';
  end if;

  if pg_catalog.to_regprocedure('public.erp_execute(text,jsonb,text)') is null then
    raise exception 'Missing public.erp_execute(text,jsonb,text)';
  end if;
  if pg_catalog.to_regprocedure('public.erp_dashboard(integer)') is null then
    raise exception 'Missing public.erp_dashboard(integer)';
  end if;
  if pg_catalog.to_regprocedure('public.erp_company_dashboard(uuid,integer)') is null then
    raise exception 'Missing public.erp_company_dashboard(uuid,integer)';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.audit_log'::pg_catalog.regclass
      and a.attname = 'actor_display_name'
      and not a.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.audit_log'::pg_catalog.regclass
      and a.attname = 'actor_email'
      and not a.attisdropped
  ) then
    raise exception 'Audit actor identity snapshots are missing';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.audit_log'::pg_catalog.regclass
      and t.tgname = 'audit_log_snapshot_actor'
      and not t.tgisinternal
  ) then
    raise exception 'Audit actor snapshot trigger is missing';
  end if;

  foreach v_name in array array[
    'current_user_access', 'inventory_position', 'inventory_stage_summary',
    'production_daily_summary', 'account_balances', 'account_balances_by_year',
    'employee_open_earnings', 'sales_outstanding', 'payroll_outstanding',
    'ledger_view', 'daily_target_work_view', 'overtime_work_view',
    'employee_salary_advance_view',
    'shared_inventory_availability'
  ]
  loop
    if pg_catalog.to_regclass('public.' || v_name) is null then
      raise exception 'Missing public read model: %', v_name;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = v_name
        and 'security_invoker=true' = any(coalesce(c.reloptions, array[]::text[]))
    ) then
      raise exception 'Read model % must use security_invoker=true', v_name;
    end if;
  end loop;

  select pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  into v_default
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public'
    and c.relname = 'profiles'
    and a.attname = 'is_active';
  if coalesce(v_default, '') not in ('false', 'false::boolean') then
    raise exception 'New profiles must default to inactive';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any(array[
        'profiles', 'roles', 'permissions', 'user_roles', 'role_permissions',
        'companies', 'company_memberships', 'company_user_roles',
        'company_inventory_balances', 'fiscal_periods',
        'inventory_ownership_transfers',
        'employees', 'employee_compensation_history', 'company_shift_settings',
        'employee_salary_advances', 'payroll_salary_advance_claims', 'conversion_types',
        'piecework_rates', 'bulk_rm_rates', 'catalog_api_credentials',
        'inventory_items', 'accounts',
        'journal_entries', 'journal_lines', 'raw_material_purchase_consignments',
        'raw_material_purchases',
        'conversions', 'conversion_workers', 'daily_work',
        'daily_work_piecework', 'daily_work_conversion_links', 'overtime_entries',
        'payroll_overtime_claims', 'production_runs',
        'quotations', 'quotation_items',
        'sales', 'sale_items', 'sale_payments', 'payrolls', 'payroll_details',
        'payroll_payments', 'stock_adjustments', 'inventory_balances',
        'stock_movements', 'audit_log', 'idempotency_keys'
      ])
      and not c.relrowsecurity
  ) then
    raise exception 'One or more exposed ERP tables do not have RLS enabled';
  end if;

  if pg_catalog.has_function_privilege(
    'anon', 'public.erp_execute(text,jsonb,text)', 'execute'
  ) then
    raise exception 'anon must not execute public.erp_execute';
  end if;
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null
     and (
       pg_catalog.has_function_privilege('anon', 'public.rls_auto_enable()', 'execute')
       or pg_catalog.has_function_privilege(
         'authenticated', 'public.rls_auto_enable()', 'execute'
       )
     ) then
    raise exception 'Data API roles must not execute public.rls_auto_enable';
  end if;
  if not pg_catalog.has_function_privilege(
    'authenticated', 'public.erp_execute(text,jsonb,text)', 'execute'
  ) then
    raise exception 'authenticated must execute public.erp_execute';
  end if;
  if not pg_catalog.has_function_privilege(
    'authenticated', 'public.erp_company_dashboard(uuid,integer)', 'execute'
  ) then
    raise exception 'authenticated must execute public.erp_company_dashboard';
  end if;
  if pg_catalog.has_schema_privilege('anon', 'private', 'usage')
     or pg_catalog.has_schema_privilege('authenticated', 'private', 'usage') then
    raise exception 'Data API roles must not have USAGE on private schema';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.profiles', 'select') then
    raise exception 'anon must not read public.profiles';
  end if;
  if not pg_catalog.has_table_privilege(
    'authenticated', 'public.current_user_access', 'select'
  ) then
    raise exception 'authenticated must read public.current_user_access';
  end if;
  if not exists (
    select 1
    from storage.buckets b
    where b.id = 'employee-profile-images'
      and not b.public
  ) then
    raise exception 'Private employee-profile-images bucket is missing';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.daily_target_entries'::pg_catalog.regclass
      and a.attname = 'night_ot_hours'
      and not a.attisdropped
  ) then
    raise exception 'Daily Work attendance and OT calculation columns are missing';
  end if;
  if not exists (
    select 1
    from public.permissions p
    join public.role_permissions rp on rp.permission_id = p.id
    join public.roles r on r.id = rp.role_id
    where p.code = 'system.admin' and r.code = 'admin'
  ) then
    raise exception 'Administrator role is missing system.admin';
  end if;
  if exists (
    select 1
    from public.profiles p
    where p.is_active
      and not exists (
        select 1
        from public.company_memberships cm
        join public.company_user_roles cur
          on cur.company_id = cm.company_id and cur.user_id = cm.user_id
        where cm.user_id = p.user_id and cm.is_active
      )
  ) then
    raise exception 'An active profile has no active company role';
  end if;
  if exists (
    select 1
    from public.profiles p
    cross join public.companies c
    where p.is_active
      and c.is_active
      and not exists (
        select 1
        from public.company_memberships cm
        join public.company_user_roles cur
          on cur.company_id = cm.company_id and cur.user_id = cm.user_id
        join public.roles r on r.id = cur.role_id
        where cm.user_id = p.user_id
          and cm.company_id = c.id
          and cm.is_active
          and r.code = 'admin'
      )
  ) then
    raise exception 'Every active profile must be an administrator in every active company';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'sales_company_invoice_no_posted_idx'
  ) then
    raise exception 'Missing company-scoped live-invoice uniqueness index';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'profiles_one_super_admin_idx'
  ) then
    raise exception 'Missing unique group super-administrator index';
  end if;
  if pg_catalog.to_regclass('public.conversion_types') is null then
    raise exception 'Missing public.conversion_types';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.piecework_rates'::regclass
      and a.attname = 'conversion_type_id'
      and not a.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.conversions'::regclass
      and a.attname = 'conversion_type_id'
      and not a.attisdropped
  ) then
    raise exception 'Conversion type links are incomplete';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.piecework_rates'::regclass
      and c.conname = 'piecework_rates_work_type_effective_from_key'
  ) then
    raise exception 'Legacy global piecework-rate uniqueness constraint still exists';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_indexes i
    where i.schemaname = 'public'
      and i.indexname = 'piecework_rates_conversion_work_effective_from_uidx'
  ) then
    raise exception 'Missing conversion-scoped piecework-rate uniqueness index';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.piecework_rates'::regclass
      and a.attname = 'conversion_type_id'
      and a.attnotnull
      and not a.attisdropped
  ) then
    raise exception 'Piecework rates must always reference a conversion type';
  end if;
  if pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure('private.perform_operation_v2(text,jsonb,uuid)')
    ),
    'piecework-rate-type:'
  ) = 0 then
    raise exception 'Atomic piecework-rate dispatcher is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.overtime_entries'::regclass
      and t.tgname = 'overtime_entries_rpc_guard'
      and not t.tgisinternal
  ) or not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.payroll_overtime_claims'::regclass
      and t.tgname = 'payroll_overtime_claims_rpc_guard'
      and not t.tgisinternal
  ) then
    raise exception 'Overtime write guards are incomplete';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.inventory_items'::regclass
      and a.attname = 'selling_price'
      and not a.attisdropped
  ) then
    raise exception 'Inventory catalogue selling price is missing';
  end if;
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'sales'
      and c.column_name = 'document_status' and c.is_nullable = 'NO'
  ) then
    raise exception 'Sales invoice document status is missing';
  end if;
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'quotations'
      and c.column_name = 'payment_method' and c.is_nullable = 'NO'
  ) then
    raise exception 'Quotation payment method is missing';
  end if;
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'quotation_items'
      and c.column_name = 'item_id' and c.is_nullable = 'YES'
  ) then
    raise exception 'Quotation items do not support manual products';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.bulk_rm_rates'::regclass
      and t.tgname = 'bulk_rm_rates_rpc_guard'
      and not t.tgisinternal
  ) or not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.raw_material_purchase_consignments'::regclass
      and t.tgname = 'raw_material_purchase_consignments_rpc_guard'
      and not t.tgisinternal
  ) then
    raise exception 'Bulk RM write guards are incomplete';
  end if;
  if pg_catalog.to_regprocedure('public.erp_verify_catalog_api_credential(uuid,text)') is null then
    raise exception 'Missing catalogue API credential verifier';
  end if;
  if pg_catalog.has_function_privilege(
       'anon', 'public.erp_verify_catalog_api_credential(uuid,text)', 'execute'
     ) or pg_catalog.has_function_privilege(
       'authenticated', 'public.erp_verify_catalog_api_credential(uuid,text)', 'execute'
     ) or not pg_catalog.has_function_privilege(
       'service_role', 'public.erp_verify_catalog_api_credential(uuid,text)', 'execute'
     ) then
    raise exception 'Catalogue API credential verifier privileges are unsafe';
  end if;
  if pg_catalog.has_column_privilege(
    'authenticated', 'public.catalog_api_credentials', 'secret_hash', 'select'
  ) then
    raise exception 'Authenticated users must never read catalogue API key hashes';
  end if;
  if pg_catalog.to_regprocedure('public.erp_public_website_catalog(uuid)') is null then
    raise exception 'Missing browser-ready website catalogue function';
  end if;
  if pg_catalog.has_function_privilege(
       'anon', 'public.erp_public_website_catalog(uuid)', 'execute'
     ) or pg_catalog.has_function_privilege(
       'authenticated', 'public.erp_public_website_catalog(uuid)', 'execute'
     ) or not pg_catalog.has_function_privilege(
       'service_role', 'public.erp_public_website_catalog(uuid)', 'execute'
     ) then
    raise exception 'Website catalogue function privileges are unsafe';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.catalog_api_credentials'::regclass
      and t.tgname = 'catalog_api_credentials_rpc_guard'
      and not t.tgisinternal
  ) then
    raise exception 'Catalogue API credential write guard is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'account_balances'
      and c.column_name = 'allow_manual_posting'
  ) then
    raise exception 'Account balance read model is missing manual-posting safety metadata';
  end if;
  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'company_inventory_position'
      and c.column_name = 'selling_price'
  ) then
    raise exception 'Company inventory read model does not expose selling price';
  end if;
end;
$checks$;

rollback;
