-- Keep the owner allowlist and new-user provisioning aligned with the two
-- accounts approved by the business owner. Passwords stay in Supabase Auth.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

lock table auth.users in share row exclusive mode;

-- Remove the obsolete owner identity from ERP authorization if it exists.
delete from public.company_user_roles cur
using auth.users u
where cur.user_id = u.id
  and pg_catalog.lower(coalesce(u.email, '')) = 'asela78@gmail.com';

delete from public.company_memberships cm
using auth.users u
where cm.user_id = u.id
  and pg_catalog.lower(coalesce(u.email, '')) = 'asela78@gmail.com';

delete from public.user_roles ur
using auth.users u
where ur.user_id = u.id
  and pg_catalog.lower(coalesce(u.email, '')) = 'asela78@gmail.com';

update public.profiles p
set is_super_admin = false,
    is_active = false,
    updated_at = pg_catalog.clock_timestamp()
from auth.users u
where p.user_id = u.id
  and pg_catalog.lower(coalesce(u.email, '')) = 'asela78@gmail.com';

-- Activate and promote the two designated owner accounts when already present.
update public.profiles p
set email = u.email,
    is_super_admin = true,
    is_active = true,
    updated_at = pg_catalog.clock_timestamp()
from auth.users u
where p.user_id = u.id
  and u.deleted_at is null
  and pg_catalog.lower(coalesce(u.email, '')) in (
    'hiranthadiass4@gmail.com',
    'info@ck-plastics.com'
  );

update public.company_memberships cm
set is_primary = false,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = cm.user_id
from public.profiles p
where p.user_id = cm.user_id
  and p.is_super_admin
  and cm.is_primary;

insert into public.company_memberships (
  company_id, user_id, is_active, is_primary, created_by, updated_by
)
select
  c.id,
  p.user_id,
  true,
  c.code = 'CK',
  p.user_id,
  p.user_id
from public.profiles p
cross join public.companies c
where p.is_super_admin and c.is_active
on conflict (company_id, user_id) do update
set is_active = true,
    is_primary = excluded.is_primary,
    updated_at = pg_catalog.clock_timestamp(),
    updated_by = excluded.updated_by;

insert into public.company_user_roles (company_id, user_id, role_id, created_by)
select cm.company_id, cm.user_id, r.id, cm.user_id
from public.company_memberships cm
join public.profiles p on p.user_id = cm.user_id and p.is_super_admin
cross join public.roles r
where cm.is_active and r.code = 'admin'
on conflict (company_id, user_id, role_id) do nothing;

insert into public.user_roles (user_id, role_id, created_by)
select p.user_id, r.id, p.user_id
from public.profiles p
cross join public.roles r
where p.is_super_admin and r.code = 'admin'
on conflict (user_id, role_id) do nothing;

-- Future Auth users receive ERP access only when their normalized email is one
-- of the two designated owner addresses.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_is_owner boolean := pg_catalog.lower(coalesce(new.email, '')) in (
    'hiranthadiass4@gmail.com',
    'info@ck-plastics.com'
  );
  v_admin_role_id bigint;
begin
  insert into public.profiles (
    user_id, display_name, email, is_active, is_super_admin
  ) values (
    new.id,
    pg_catalog.left(coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
      ''
    ), 200),
    new.email,
    v_is_owner,
    v_is_owner
  )
  on conflict (user_id) do update
  set email = excluded.email,
      is_active = profiles.is_active or excluded.is_active,
      is_super_admin = profiles.is_super_admin or excluded.is_super_admin,
      updated_at = pg_catalog.clock_timestamp();

  if not v_is_owner then
    return new;
  end if;

  select r.id into v_admin_role_id
  from public.roles r
  where r.code = 'admin';

  if v_admin_role_id is null then
    raise exception 'The Admin role is unavailable';
  end if;

  insert into public.company_memberships (
    company_id, user_id, is_active, is_primary, created_by, updated_by
  )
  select c.id, new.id, true, c.code = 'CK', new.id, new.id
  from public.companies c
  where c.is_active
  on conflict (company_id, user_id) do update
  set is_active = true,
      is_primary = excluded.is_primary,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = new.id;

  insert into public.company_user_roles (company_id, user_id, role_id, created_by)
  select cm.company_id, new.id, v_admin_role_id, new.id
  from public.company_memberships cm
  where cm.user_id = new.id and cm.is_active
  on conflict (company_id, user_id, role_id) do nothing;

  insert into public.user_roles (user_id, role_id, created_by)
  values (new.id, v_admin_role_id, new.id)
  on conflict (user_id, role_id) do nothing;

  return new;
end;
$function$;

revoke all on function private.handle_new_auth_user()
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
