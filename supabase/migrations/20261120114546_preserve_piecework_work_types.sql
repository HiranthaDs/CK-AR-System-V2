-- Keep the selected conversion master and the salary-sheet work description
-- as separate values. The previous conversion wrapper normalized work_type to
-- the conversion type name even when the client supplied a work description.

begin;

alter function private.perform_operation_v2(text, jsonb, uuid)
  rename to perform_operation_before_piecework_work_types;

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
  v_result jsonb;
  v_work_type text;
  v_rate_id uuid;
begin
  if p_operation = 'piecework_rate.upsert' then
    v_work_type := nullif(pg_catalog.btrim(p_payload ->> 'work_type'), '');
    if v_work_type is null then
      raise exception using
        errcode = '22023',
        message = 'Work type is required';
    end if;
  end if;

  v_result := private.perform_operation_before_piecework_work_types(
    p_operation,
    p_payload,
    p_actor
  );

  if p_operation = 'piecework_rate.upsert' then
    v_rate_id := (v_result ->> 'id')::uuid;
    update public.piecework_rates
    set work_type = pg_catalog.left(v_work_type, 160),
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor
    where id = v_rate_id;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'Saved conversion rate was not found';
    end if;
  end if;

  return v_result;
end;
$function$;

revoke all on function
  private.perform_operation_before_piecework_work_types(text, jsonb, uuid),
  private.perform_operation_v2(text, jsonb, uuid)
from public, anon, authenticated;

commit;
