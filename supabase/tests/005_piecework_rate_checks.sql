-- Transactional verification for conversion-rate add, edit, scoping, and
-- overlap behavior. The final rollback removes every test master and receipt.
begin;

do $select_test_admin$
declare
  v_user_id uuid;
begin
  select p.user_id
  into v_user_id
  from public.profiles p
  where p.is_active
    and p.is_super_admin
    and exists (
      select 1
      from public.company_memberships cm
      where cm.user_id = p.user_id
        and cm.is_active
    )
  order by p.created_at, p.user_id
  limit 1;

  if v_user_id is null then
    raise exception 'An active group super administrator is required';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_user_id::text, true);
end;
$select_test_admin$;

set local role authenticated;

do $piecework_rate_checks$
declare
  v_company_id uuid;
  v_type_1 uuid := pg_catalog.gen_random_uuid();
  v_type_2 uuid := pg_catalog.gen_random_uuid();
  v_rate_1 uuid;
  v_rate_2 uuid;
  v_rate_3 uuid;
  v_result jsonb;
  v_overlap_rejected boolean := false;
begin
  select cm.company_id
  into v_company_id
  from public.company_memberships cm
  where cm.user_id = (select auth.uid())
    and cm.is_active
  order by cm.is_primary desc, cm.created_at, cm.company_id
  limit 1;
  if v_company_id is null then
    raise exception 'The test administrator needs an active company';
  end if;

  perform public.erp_execute(
    'conversion_type.upsert',
    pg_catalog.jsonb_build_object(
      'id', v_type_1,
      'company_id', v_company_id,
      'name', 'TEST A Bulk to TEST A Chip',
      'default_chip_name', 'TEST A Chip',
      'status', 'active'
    ),
    'test-piecework-type-a-0001'
  );
  perform public.erp_execute(
    'conversion_type.upsert',
    pg_catalog.jsonb_build_object(
      'id', v_type_2,
      'company_id', v_company_id,
      'name', 'TEST B Bulk to TEST B Chip',
      'default_chip_name', 'TEST B Chip',
      'status', 'active'
    ),
    'test-piecework-type-b-0001'
  );

  v_result := public.erp_execute(
    'piecework_rate.upsert',
    pg_catalog.jsonb_build_object(
      'company_id', v_company_id,
      'conversion_type_id', v_type_1,
      'work_type', 'Grinding',
      'rate_per_kg', 11,
      'effective_from', '2099-01-01',
      'effective_to', '2099-01-31',
      'status', 'active'
    ),
    'test-piecework-add-0001'
  );
  v_rate_1 := (v_result ->> 'id')::uuid;
  if v_rate_1 is null then
    raise exception 'Adding a conversion rate did not return an identifier';
  end if;

  -- Updating the same logical rate must not collide with its own unique key.
  v_result := public.erp_execute(
    'piecework_rate.upsert',
    pg_catalog.jsonb_build_object(
      'id', v_rate_1,
      'company_id', v_company_id,
      'conversion_type_id', v_type_1,
      'work_type', 'Grinding',
      'rate_per_kg', 12.5,
      'effective_from', '2099-01-01',
      'effective_to', '2099-01-31',
      'status', 'active'
    ),
    'test-piecework-edit-0001'
  );

  -- The same work and date are valid for a different conversion master.
  v_result := public.erp_execute(
    'piecework_rate.upsert',
    pg_catalog.jsonb_build_object(
      'company_id', v_company_id,
      'conversion_type_id', v_type_2,
      'work_type', 'Grinding',
      'rate_per_kg', 13,
      'effective_from', '2099-01-01',
      'effective_to', '2099-01-31',
      'status', 'active'
    ),
    'test-piecework-other-type-0001'
  );
  v_rate_2 := (v_result ->> 'id')::uuid;

  -- A second task for the same conversion can start on the same date.
  v_result := public.erp_execute(
    'piecework_rate.upsert',
    pg_catalog.jsonb_build_object(
      'company_id', v_company_id,
      'conversion_type_id', v_type_1,
      'work_type', 'Washing',
      'rate_per_kg', 7,
      'effective_from', '2099-01-01',
      'effective_to', '2099-01-31',
      'status', 'active'
    ),
    'test-piecework-other-work-0001'
  );
  v_rate_3 := (v_result ->> 'id')::uuid;

  begin
    perform public.erp_execute(
      'piecework_rate.upsert',
      pg_catalog.jsonb_build_object(
        'company_id', v_company_id,
        'conversion_type_id', v_type_1,
        'work_type', 'Grinding',
        'rate_per_kg', 99,
        'effective_from', '2099-01-15',
        'effective_to', '2099-02-15',
        'status', 'active'
      ),
      'test-piecework-overlap-0001'
    );
  exception
    when unique_violation then
      if pg_catalog.strpos(sqlerrm, 'already covers part of this effective period') = 0 then
        raise;
      end if;
      v_overlap_rejected := true;
  end;

  if not v_overlap_rejected then
    raise exception 'An overlapping active conversion rate was accepted';
  end if;
  if (select rate_per_kg from public.piecework_rates where id = v_rate_1) <> 12.5 then
    raise exception 'Editing a conversion rate did not persist the new value';
  end if;
  if (
    select pg_catalog.count(*)
    from public.piecework_rates
    where id in (v_rate_1, v_rate_2, v_rate_3)
  ) <> 3 then
    raise exception 'Valid conversion-scoped rates were not all saved';
  end if;
end;
$piecework_rate_checks$;

rollback;
