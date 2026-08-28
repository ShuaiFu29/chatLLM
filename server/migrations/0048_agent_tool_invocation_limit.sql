-- A per-tool ceiling on how often one Agent run may invoke it.
--
-- The global ceiling (AGENT_MAX_TOOL_CALLS_PER_RUN) bounds a run's total tool
-- volume, but it treats every tool alike. A tool that sends email, charges a card
-- or deletes a record needs a bound of its own: forty calls is a reasonable total
-- for a research run and an unreasonable number of refunds. Subagent fan-out makes
-- this sharper, because the total is shared across a tree while each child decides
-- its own calls.
--
-- NULL means "only the global ceiling applies", so existing tools keep their
-- current behaviour and this stays an opt-in tightening.
alter table agent_tools
  add column if not exists max_invocations_per_run smallint;

alter table agent_tools
  drop constraint if exists agent_tools_max_invocations_check;
alter table agent_tools
  add constraint agent_tools_max_invocations_check
  check (max_invocations_per_run is null or max_invocations_per_run between 1 and 100);

comment on column agent_tools.max_invocations_per_run is
  'Maximum invocations of this tool within a single Agent run. NULL means only the global per-run ceiling applies.';
