/**
 * Shared predicate for an expired Work Item boundary that the durable recovery
 * worker can safely claim today. Keep the aliases (`work`, `checkpoint`, and
 * `invocation`) stable so scanner and maintenance sweepers cannot drift.
 *
 * PostgreSQL does not promise boolean short-circuit evaluation. Every
 * `jsonb_array_elements` call therefore receives an array even when a corrupt
 * or legacy payload stores a scalar. Invalid model payloads remain recoverable
 * so the worker can terminalize them explicitly; invalid tool checkpoints are
 * left to the integrity/staleness path.
 */
export const RECOVERABLE_EXPIRED_AGENT_WORK_ITEM_SQL = `(
  (
    checkpoint.run_id is null
    and jsonb_typeof(work.payload -> 'initial_execution') = 'object'
    and jsonb_typeof(work.payload #> '{initial_execution,messages}') = 'array'
    and jsonb_typeof(work.payload #> '{initial_execution,deadline_at}') = 'number'
    and jsonb_typeof(work.payload #> '{initial_execution,optional_history_count}') = 'number'
  )
  or checkpoint.boundary = 'execution_ready'
  or checkpoint.boundary = 'final_answer_ready'
  or (
    checkpoint.boundary = 'model_ready'
    and (
      invocation.id is null
      or invocation.status <> 'succeeded'
      or invocation.result_payload is null
      or jsonb_typeof(invocation.result_payload -> 'tool_calls') <> 'array'
      or not exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(invocation.result_payload -> 'tool_calls') = 'array'
              then invocation.result_payload -> 'tool_calls'
            else '[]'::jsonb
          end
        ) call
        where not exists (
          select 1
          from agent_tool_invocations tool_invocation
          where tool_invocation.run_id = work.run_id
            and tool_invocation.tool_call_id = call ->> 'id'
        )
      )
    )
  )
  or (
    checkpoint.boundary = 'tool_batch_ready'
    and jsonb_typeof(checkpoint.payload #> '{pending,toolCalls}') = 'array'
    and not exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(checkpoint.payload #> '{pending,toolCalls}') = 'array'
            then checkpoint.payload #> '{pending,toolCalls}'
          else '[]'::jsonb
        end
      ) call
      where not exists (
        select 1
        from agent_tool_invocations tool_invocation
        where tool_invocation.run_id = work.run_id
          and tool_invocation.tool_call_id = call ->> 'id'
      )
    )
  )
  or checkpoint.boundary = 'approval_wait'
  or checkpoint.boundary = 'subagents_wait'
)`;
