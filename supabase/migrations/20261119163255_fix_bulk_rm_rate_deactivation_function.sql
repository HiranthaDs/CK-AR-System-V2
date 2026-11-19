begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- The dispatcher was renamed by the catalogue integration migration. Repair
-- the earlier Bulk RM rate branch in place without changing its audited
-- behavior or the wrapper chain around it.
do $repair_bulk_rate_dispatcher$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'private.perform_operation_v2_before_catalog_integrations(text,jsonb,uuid)'::pg_catalog.regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'Bulk RM dispatcher function is missing';
  end if;

  v_definition := pg_catalog.replace(
    v_definition,
    'pg_catalog.greatest(effective_from, current_date)',
    'greatest(effective_from, current_date)'
  );
  execute v_definition;
end;
$repair_bulk_rate_dispatcher$;

commit;
