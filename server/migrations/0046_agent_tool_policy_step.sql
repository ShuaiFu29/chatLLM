-- Record the policy decision that shapes a Run before the model ever sees a tool.
--
-- Tools refused by the approval policy are now withheld from the advertised tool
-- list instead of being rejected after the model picks one. That is cheaper and
-- clearer, but it also makes the absence invisible: without a record, an operator
-- debugging "why did the Agent not use the write tool I bound to it" has nothing
-- to look at. This step kind captures the resolved policy and the withheld tools.
alter table agent_steps
  drop constraint if exists agent_steps_kind_check;
alter table agent_steps
  add constraint agent_steps_kind_check
  check (kind in (
    'model', 'tool_call', 'tool_result', 'approval', 'assistant',
    'plan', 'memory_read', 'memory_write', 'context_evicted',
    'budget_check', 'subagent_dispatch', 'subagent_result',
    'tool_policy'
  ));
