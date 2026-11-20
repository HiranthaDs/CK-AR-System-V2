-- Repair the conversion dispatcher introduced with the conversion type master.
-- `value <> any(array[...])` is true when value differs from even one array
-- member. The dispatcher needs `<> all(...)` so only operations absent from
-- the complete conversion-operation list are delegated to the older handler.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $migration$
declare
  v_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'private.perform_operation_before_overtime(text,jsonb,uuid)'
  );
  v_definition text;
  v_fixed_definition text;
  v_buggy_predicate constant text := 'p_operation <> any(array[';
  v_fixed_predicate constant text := 'p_operation <> all(array[';
begin
  if v_function is null then
    raise exception using
      errcode = '42883',
      message = 'Conversion operation dispatcher function is missing';
  end if;

  select pg_catalog.pg_get_functiondef(v_function)
  into v_definition;

  if pg_catalog.strpos(v_definition, v_fixed_predicate) > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_definition, v_buggy_predicate) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'Conversion operation dispatcher has an unexpected definition';
  end if;
  if pg_catalog.strpos(v_definition, 'conversion_type.upsert') = 0
     or pg_catalog.strpos(v_definition, 'piecework_rate.upsert') = 0
     or pg_catalog.strpos(v_definition, 'conversion.post') = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'Conversion operation dispatcher does not contain the expected operations';
  end if;

  v_fixed_definition := pg_catalog.replace(
    v_definition,
    v_buggy_predicate,
    v_fixed_predicate
  );
  if pg_catalog.strpos(v_fixed_definition, v_buggy_predicate) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'Conversion operation dispatcher repair was incomplete';
  end if;

  execute v_fixed_definition;
end;
$migration$;

-- The automatic invoice/quotation number wrapper also schema-qualified the
-- SQL GREATEST expression. PostgreSQL accepts the function definition but the
-- affected save fails when that assignment executes, so normalize it here.
do $migration$
declare
  v_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'private.perform_operation_before_piecework_work_types(text,jsonb,uuid)'
  );
  v_definition text;
  v_fixed_definition text;
begin
  if v_function is null then
    raise exception using
      errcode = '42883',
      message = 'Document numbering dispatcher function is missing';
  end if;

  select pg_catalog.pg_get_functiondef(v_function)
  into v_definition;

  if pg_catalog.strpos(v_definition, 'pg_catalog.greatest(') = 0 then
    return;
  end if;
  v_fixed_definition := pg_catalog.replace(
    v_definition,
    'pg_catalog.greatest(',
    'greatest('
  );
  if pg_catalog.strpos(v_fixed_definition, 'pg_catalog.greatest(') > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'Document numbering dispatcher repair was incomplete';
  end if;

  execute v_fixed_definition;
end;
$migration$;

revoke all on function
  private.perform_operation_before_overtime(text, jsonb, uuid),
  private.perform_operation_before_piecework_work_types(text, jsonb, uuid)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
