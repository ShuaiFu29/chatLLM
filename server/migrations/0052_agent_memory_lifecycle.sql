-- Preserve the supersession history when a user forgets a replacement memory.
--
-- `superseded_by` originally used ON DELETE SET NULL while forget and expiry
-- cleanup physically deleted rows. Deleting B from A -> B therefore changed A
-- back to an active memory and silently resurrected information the user had
-- replaced. A tombstone keeps both the history and the user's deletion intent:
-- neither A nor deleted B is recallable, while the database lifecycle audit can
-- still explain what happened.
alter table agent_memories
  add column if not exists deleted_at timestamptz;

comment on column agent_memories.deleted_at is
  'Soft-deletion tombstone. Deleted memories remain non-recallable so rows they superseded can never become active again; content and embeddings are erased.';

-- Make a replay safe after a manually interrupted migration. The normal runner
-- executes this whole file transactionally, but a previously installed lifecycle
-- trigger must not reject the repair statements below.
drop trigger if exists agent_memories_supersession_trigger on agent_memories;

alter table agent_memories
  drop constraint if exists agent_memories_deleted_payload_check;

-- The legacy unique index treats every row with superseded_by = null as active.
-- Repairing several invalid edges below erases each payload to the same marker and
-- clears its edge, so leaving that index in place can make a valid cleanup fail on
-- duplicate `[deleted]` hashes. Remove it before touching legacy rows; the final
-- partial index is recreated after deleted_at participates in the active predicate.
drop index if exists agent_memories_dedupe_idx;

-- A tombstone preserves only lifecycle metadata. Keeping the original content or
-- vector would turn a UI-level "forget" into concealment rather than deletion.
-- This also normalizes a tombstone left by an interrupted/manual migration before
-- the payload constraint is restored. Fully normalized rows are not touched, so a
-- replay does not rewrite updated_at merely because it was replayed.
update agent_memories
set content = '[deleted]',
    embedding = null,
    embedding_model = null,
    provenance_run_id = null,
    provenance_step_id = null,
    expires_at = null,
    updated_at = now()
where deleted_at is not null
  and (
    content <> '[deleted]'
    or embedding is not null
    or embedding_model is not null
    or provenance_run_id is not null
    or provenance_step_id is not null
    or expires_at is not null
  );

-- Releases before this migration accepted an arbitrary replacement UUID in the
-- repository. The FK proved only that the row existed, so a guessed UUID could
-- leave an old cross-user/cross-scope edge behind. Clearing that edge alone would
-- reactivate the predecessor; erase and tombstone it instead.
update agent_memories memory
set deleted_at = coalesce(memory.deleted_at, now()),
    content = '[deleted]',
    embedding = null,
    embedding_model = null,
    provenance_run_id = null,
    provenance_step_id = null,
    superseded_by = null,
    expires_at = null,
    updated_at = now()
from agent_memories replacement
where memory.superseded_by = replacement.id
  and (
    replacement.user_id <> memory.user_id
    or replacement.scope <> memory.scope
    or replacement.scope_ref_id is distinct from memory.scope_ref_id
  );

-- The old two-parameter update also allowed A -> B followed by B -> A. Start a
-- walk from every superseded row; starts that eventually point back to themselves
-- are cycle members. Tombstoning every member breaks the cycle without reviving
-- any content. Rows outside a cycle that point into it keep their historical edge.
with recursive replacement_walk(start_id, id, superseded_by, path) as (
  select id, id, superseded_by, array[id]
  from agent_memories
  where superseded_by is not null
  union all
  select walk.start_id, next.id, next.superseded_by, walk.path || next.id
  from replacement_walk walk
  join agent_memories next on next.id = walk.superseded_by
  where walk.superseded_by is not null
    and not walk.superseded_by = any(walk.path)
), cycle_rows as (
  select distinct start_id as id
  from replacement_walk
  where superseded_by = start_id
)
update agent_memories memory
set deleted_at = coalesce(memory.deleted_at, now()),
    content = '[deleted]',
    embedding = null,
    embedding_model = null,
    provenance_run_id = null,
    provenance_step_id = null,
    superseded_by = null,
    expires_at = null,
    updated_at = now()
where memory.id in (select id from cycle_rows);

alter table agent_memories
  add constraint agent_memories_deleted_payload_check check (
    deleted_at is null
    or (
      content = '[deleted]'
      and embedding is null
      and embedding_model is null
      and provenance_run_id is null
      and provenance_step_id is null
      and expires_at is null
    )
  );

-- Hard-deleting a referenced replacement would recreate the original bug even
-- after adding tombstones. Reject that operation instead of clearing the link.
-- Deleting a user still removes all of that user''s memory rows in one statement,
-- so the user-owned cascade remains intact.
alter table agent_memories
  drop constraint if exists agent_memories_superseded_by_fkey;
alter table agent_memories
  add constraint agent_memories_superseded_by_fkey
  foreign key (superseded_by) references agent_memories(id)
  on delete no action
  deferrable initially immediate;

-- Validate direct SQL as well as the repository path. The replacement is locked
-- while it is checked, so two opposite updates cannot both establish a cycle.
create or replace function enforce_agent_memory_supersession()
returns trigger
language plpgsql
as $$
declare
  replacement agent_memories%rowtype;
begin
  -- These columns define a memory's owner and namespace. No supported API moves a
  -- memory after creation, and allowing it would invalidate every row that points
  -- at this one as its replacement. Immutability removes that race entirely.
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id
      or new.scope is distinct from old.scope
      or new.scope_ref_id is distinct from old.scope_ref_id then
      raise exception using
        errcode = '23514',
        constraint = 'agent_memories_identity_immutable_check',
        message = 'Agent memory user and scope are immutable';
    end if;

    if old.deleted_at is not null
      and new.deleted_at is distinct from old.deleted_at then
      raise exception using
        errcode = '23514',
        constraint = 'agent_memories_deletion_immutable_check',
        message = 'a deleted Agent memory cannot be restored';
    end if;

    -- Supersession is append-only lifecycle history. Clearing or redirecting an
    -- established edge would revive an old fact or rewrite why it became inactive.
    if old.superseded_by is not null
      and new.superseded_by is distinct from old.superseded_by then
      raise exception using
        errcode = '23514',
        constraint = 'agent_memories_supersession_immutable_check',
        message = 'an Agent memory supersession cannot be changed';
    end if;

    if new.superseded_by is not distinct from old.superseded_by then
      return new;
    end if;
  end if;

  if new.superseded_by is null then
    return new;
  end if;

  if new.deleted_at is not null then
    raise exception using
      errcode = '23514',
      constraint = 'agent_memories_deleted_supersession_check',
      message = 'a deleted Agent memory cannot be superseded';
  end if;

  if new.superseded_by = new.id then
    raise exception using
      errcode = '23514',
      constraint = 'agent_memories_self_supersede_check',
      message = 'an Agent memory cannot supersede itself';
  end if;

  select * into replacement
  from agent_memories
  where id = new.superseded_by
  -- superseded_by and deleted_at are non-key updates. FOR KEY SHARE is compatible
  -- with those updates, which lets concurrent direct SQL A -> B and B -> A both
  -- observe the other row as active and commit a cycle. FOR UPDATE makes the
  -- validation and edge creation one serialized decision; a deadlock victim rolls
  -- back the whole statement and a retry observes the winning edge.
  for update;

  if not found then
    -- The FK would reject this at statement end; raising here keeps every
    -- supersession validation failure deterministic and immediately visible.
    raise exception using
      errcode = '23503',
      constraint = 'agent_memories_superseded_by_fkey',
      message = 'replacement Agent memory does not exist';
  end if;

  if replacement.user_id <> new.user_id
    or replacement.scope <> new.scope
    or replacement.scope_ref_id is distinct from new.scope_ref_id then
    raise exception using
      errcode = '23514',
      constraint = 'agent_memories_supersession_scope_check',
      message = 'replacement Agent memory must belong to the same user and scope';
  end if;

  if exists (
    with recursive replacement_chain(id, superseded_by, path) as (
      select id, superseded_by, array[id]
      from agent_memories
      where id = new.superseded_by
      union all
      select next.id, next.superseded_by, chain.path || next.id
      from replacement_chain chain
      join agent_memories next on next.id = chain.superseded_by
      where not next.id = any(chain.path)
    )
    select 1 from replacement_chain where id = new.id
  ) then
    raise exception using
      errcode = '23514',
      constraint = 'agent_memories_supersession_cycle_check',
      message = 'Agent memory supersession cannot form a cycle';
  end if;

  if replacement.deleted_at is not null
    or replacement.superseded_by is not null
    or (replacement.expires_at is not null and replacement.expires_at <= now()) then
    raise exception using
      errcode = '23514',
      constraint = 'agent_memories_supersession_active_check',
      message = 'replacement Agent memory must be active';
  end if;

  return new;
end;
$$;

create trigger agent_memories_supersession_trigger
before insert or update of superseded_by, user_id, scope, scope_ref_id, deleted_at
on agent_memories
for each row execute function enforce_agent_memory_supersession();

-- Every active-row access path must agree on what "active" means. Recreate the
-- partial indexes so a deleted memory neither participates in recall nor blocks
-- the same fact from being remembered again.
drop index if exists agent_memories_scope_idx;
create index agent_memories_scope_idx
  on agent_memories (user_id, scope, scope_ref_id, created_at desc)
  where superseded_by is null and deleted_at is null;

drop index if exists agent_memories_expiry_idx;
create index agent_memories_expiry_idx
  on agent_memories (expires_at)
  where expires_at is not null and deleted_at is null;

drop index if exists agent_memories_dedupe_idx;
create unique index agent_memories_dedupe_idx
  on agent_memories (
    user_id,
    scope,
    coalesce(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    md5(content)
  )
  where superseded_by is null and deleted_at is null;

drop index if exists agent_memories_deleted_idx;
create index agent_memories_deleted_idx
  on agent_memories (deleted_at)
  where deleted_at is not null;

-- PostgreSQL does not create indexes for foreign-key referencing columns. These
-- two cover every lifecycle row, including superseded and deleted rows that are
-- intentionally absent from the recall index. They keep user cascades and the
-- self-FK's replacement delete check from degrading into full-table scans.
drop index if exists agent_memories_user_idx;
create index agent_memories_user_idx
  on agent_memories (user_id);

drop index if exists agent_memories_superseded_by_idx;
create index agent_memories_superseded_by_idx
  on agent_memories (superseded_by)
  where superseded_by is not null;
