-- Allow a freshly claimed Work Item to publish the deterministic model context
-- before any provider or tool side effect. A recovery Worker can recreate this
-- boundary from the hashed Work Item payload when the original process dies in
-- the run-created -> first-checkpoint gap.
alter table agent_run_checkpoints
  drop constraint if exists agent_run_checkpoints_boundary_check;

alter table agent_run_checkpoints
  add constraint agent_run_checkpoints_boundary_check check (boundary in (
    'execution_ready', 'model_ready', 'tool_batch_ready', 'approval_wait',
    'subagents_wait', 'final_answer_ready'
  ));

