-- Durable Agent memory.
--
-- What existed before was not memory. `memory_mode` chose between no history and
-- a fixed window of the last twenty conversation messages, and the `user` and
-- `project` modes appended a static block to the system prompt (the persona
-- profile, the project name and description). Nothing was ever written, nothing
-- expired, and nothing could be recalled across conversations.
--
-- Every row carries its provenance and how much the content should be trusted,
-- because memory is a persistence mechanism for prompt injection: a poisoned fact
-- extracted from an untrusted tool response would influence every later Run for
-- that user. Trust is therefore a stored property, not an assumption.
create table if not exists agent_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- 'user' spans everything the user does; 'project' is scoped to one workspace;
  -- 'agent' is private to a single Agent's own accumulated knowledge.
  scope text not null,
  scope_ref_id uuid,
  kind text not null,
  content text not null,
  -- Where the content came from, so a memory can be audited back to the exact
  -- step that produced it.
  provenance_run_id uuid references agent_runs(id) on delete set null,
  provenance_step_id uuid references agent_steps(id) on delete set null,
  -- 'user_stated' is something the person said; 'agent_inferred' is a conclusion
  -- the model drew; 'tool_derived' came out of an untrusted tool response and is
  -- labelled as such wherever it is injected.
  source_trust text not null,
  -- Lets "the user changed their mind" be expressed, instead of leaving the old
  -- and new fact to contradict each other in the same prompt.
  superseded_by uuid references agent_memories(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_memories_scope_check check (scope in ('user', 'project', 'agent')),
  -- A scoped memory without its subject would be silently global.
  constraint agent_memories_scope_ref_check check (
    (scope = 'user' and scope_ref_id is null)
    or (scope in ('project', 'agent') and scope_ref_id is not null)
  ),
  constraint agent_memories_kind_check check (
    kind in ('fact', 'preference', 'decision', 'summary')
  ),
  constraint agent_memories_source_trust_check check (
    source_trust in ('user_stated', 'agent_inferred', 'tool_derived')
  ),
  -- Bounded so a single memory cannot dominate a prompt or an operational view.
  constraint agent_memories_content_check check (
    length(content) between 1 and 2000
  ),
  constraint agent_memories_self_supersede_check check (superseded_by is null or superseded_by <> id)
);

-- Recall reads live rows for one scope, newest first.
create index if not exists agent_memories_scope_idx
  on agent_memories (user_id, scope, scope_ref_id, created_at desc)
  where superseded_by is null;
create index if not exists agent_memories_expiry_idx
  on agent_memories (expires_at)
  where expires_at is not null and superseded_by is null;
create index if not exists agent_memories_provenance_idx
  on agent_memories (provenance_run_id)
  where provenance_run_id is not null;

-- The same statement of the same fact in the same scope should update rather than
-- accumulate. Without this a loop that re-remembers on every Run would grow the
-- store without bound and crowd recall with duplicates.
create unique index if not exists agent_memories_dedupe_idx
  on agent_memories (user_id, scope, coalesce(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, md5(content))
  where superseded_by is null;
