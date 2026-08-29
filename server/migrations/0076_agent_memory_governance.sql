-- R4 Memory governance: explicit candidate/confirmation lifecycle, bounded
-- verification metadata, recall accounting, provenance evidence and an
-- append-only event stream. Existing tool-derived rows are quarantined rather
-- than silently injected after this migration.

alter table agent_memories
  add column if not exists status text not null default 'confirmed';
alter table agent_memories
  add column if not exists verification_status text not null default 'legacy_confirmed';
alter table agent_memories
  add column if not exists verified_at timestamptz;
alter table agent_memories
  add column if not exists confidence real not null default 0.5;
alter table agent_memories
  add column if not exists sensitivity text not null default 'personal';
alter table agent_memories
  add column if not exists last_recalled_at timestamptz;
alter table agent_memories
  add column if not exists recall_count bigint not null default 0;

update agent_memories
set confidence = case source_trust
      when 'user_stated' then 1.0
      when 'agent_inferred' then 0.6
      else 0.3
    end,
    status = case
      when source_trust = 'tool_derived'
        and deleted_at is null
        and superseded_by is null
        and (expires_at is null or expires_at > now())
      then 'candidate'
      else 'confirmed'
    end,
    verification_status = case
      when source_trust = 'tool_derived'
        and deleted_at is null
        and superseded_by is null
        and (expires_at is null or expires_at > now())
      then 'unverified'
      else 'legacy_confirmed'
    end,
    verified_at = null
-- On the first application every legacy row has these column defaults. Keeping
-- the predicate explicit makes a manual replay harmless: a later user decision
-- is never reset to candidate or stripped of its verification timestamp.
where status = 'confirmed'
  and verification_status = 'legacy_confirmed'
  and verified_at is null;

alter table agent_memories
  drop constraint if exists agent_memories_status_check;
alter table agent_memories
  add constraint agent_memories_status_check
  check (status in ('candidate', 'confirmed', 'rejected'));

alter table agent_memories
  drop constraint if exists agent_memories_verification_check;
alter table agent_memories
  add constraint agent_memories_verification_check check (
    (
      status = 'candidate'
      and verification_status = 'unverified'
      and verified_at is null
      and superseded_by is null
    )
    or (
      status = 'confirmed'
      and verification_status in ('legacy_confirmed', 'policy_confirmed', 'user_confirmed')
      and (
        verification_status = 'legacy_confirmed'
        or verified_at is not null
      )
    )
    or (
      status = 'rejected'
      and verification_status = 'user_rejected'
      and verified_at is not null
      and superseded_by is null
    )
  );

alter table agent_memories
  drop constraint if exists agent_memories_confidence_check;
alter table agent_memories
  add constraint agent_memories_confidence_check
  check (confidence between 0 and 1);

alter table agent_memories
  drop constraint if exists agent_memories_sensitivity_check;
alter table agent_memories
  add constraint agent_memories_sensitivity_check
  check (sensitivity in ('normal', 'personal', 'sensitive', 'restricted'));

alter table agent_memories
  drop constraint if exists agent_memories_recall_check;
alter table agent_memories
  add constraint agent_memories_recall_check check (
    recall_count >= 0
    and (
      (recall_count = 0 and last_recalled_at is null)
      or (recall_count > 0 and last_recalled_at is not null)
    )
  );

create unique index if not exists agent_memories_id_user_unique_idx
  on agent_memories(id, user_id);

create table if not exists agent_memory_evidence (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null,
  user_id uuid not null,
  evidence_kind text not null,
  -- Stable provenance ids are ownership-validated by the insert trigger below,
  -- but intentionally have no FK. An ON DELETE SET NULL action would UPDATE an
  -- append-only audit row; retaining the id also makes deletion itself visible.
  source_run_id uuid,
  source_step_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_memory_evidence_memory_user_fkey
    foreign key (memory_id, user_id)
    references agent_memories(id, user_id)
    on delete cascade,
  constraint agent_memory_evidence_kind_check
    check (evidence_kind in ('agent_run', 'user_confirmation', 'legacy')),
  constraint agent_memory_evidence_source_check
    check (source_step_id is null or source_run_id is not null),
  constraint agent_memory_evidence_metadata_check
    check (
      jsonb_typeof(metadata) = 'object'
      and octet_length(metadata::text) <= 16384
    )
);

create unique index if not exists agent_memory_evidence_source_unique_idx
  on agent_memory_evidence(
    memory_id,
    evidence_kind,
    coalesce(source_run_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(source_step_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create table if not exists agent_memory_events (
  id bigint generated always as identity primary key,
  memory_id uuid not null,
  user_id uuid not null,
  event_type text not null,
  actor_type text not null,
  source_run_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_memory_events_memory_user_fkey
    foreign key (memory_id, user_id)
    references agent_memories(id, user_id)
    on delete cascade,
  constraint agent_memory_events_type_check
    check (event_type in (
      'proposed', 'confirmed', 'rejected', 'recalled',
      'superseded', 'deleted', 'expired'
    )),
  constraint agent_memory_events_actor_check
    check (actor_type in ('user', 'agent', 'system')),
  constraint agent_memory_events_details_check
    check (
      jsonb_typeof(details) = 'object'
      and octet_length(details::text) <= 16384
    )
);

create index if not exists agent_memory_events_memory_cursor_idx
  on agent_memory_events(memory_id, id desc);
create index if not exists agent_memory_events_user_cursor_idx
  on agent_memory_events(user_id, id desc);

create or replace function validate_agent_memory_audit_source()
returns trigger
language plpgsql
as $$
declare
  audit_step_id uuid;
begin
  if new.source_run_id is not null and not exists (
    select 1
    from agent_runs run
    where run.id = new.source_run_id and run.user_id = new.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Agent Memory audit Run must belong to the Memory owner';
  end if;

  audit_step_id := nullif(to_jsonb(new) ->> 'source_step_id', '')::uuid;
  if audit_step_id is not null and not exists (
    select 1
    from agent_steps step
    where step.id = audit_step_id and step.run_id = new.source_run_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Agent Memory evidence Step must belong to its source Run';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_memory_evidence_source_guard on agent_memory_evidence;
create trigger agent_memory_evidence_source_guard
before insert on agent_memory_evidence
for each row execute function validate_agent_memory_audit_source();

drop trigger if exists agent_memory_events_source_guard on agent_memory_events;
create trigger agent_memory_events_source_guard
before insert on agent_memory_events
for each row execute function validate_agent_memory_audit_source();

create or replace function reject_agent_memory_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  -- A hard parent/user cascade is the only deletion path. Direct audit-row
  -- deletion runs at trigger depth one and is rejected.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Agent Memory evidence and events are append-only';
end;
$$;

drop trigger if exists agent_memory_evidence_immutable_guard on agent_memory_evidence;
create trigger agent_memory_evidence_immutable_guard
before update or delete on agent_memory_evidence
for each row execute function reject_agent_memory_audit_mutation();

drop trigger if exists agent_memory_events_immutable_guard on agent_memory_events;
create trigger agent_memory_events_immutable_guard
before update or delete on agent_memory_events
for each row execute function reject_agent_memory_audit_mutation();

-- Give pre-governance rows a bounded, content-free origin. Valid legacy Run and
-- Step references are retained; invalid cross-owner links are deliberately not
-- copied into the append-only ledger. Both statements are replay-safe.
insert into agent_memory_evidence (
  memory_id, user_id, evidence_kind, source_run_id, source_step_id, metadata
)
select
  memory.id,
  memory.user_id,
  'legacy',
  valid_run.id,
  valid_step.id,
  jsonb_build_object(
    'migration', '0076',
    'source_trust', memory.source_trust,
    'provenance_valid', (
      (memory.provenance_run_id is null and memory.provenance_step_id is null)
      or (
        valid_run.id is not null
        and (memory.provenance_step_id is null or valid_step.id is not null)
      )
    )
  )
from agent_memories memory
left join agent_runs valid_run
  on valid_run.id = memory.provenance_run_id
 and valid_run.user_id = memory.user_id
left join agent_steps valid_step
  on valid_step.id = memory.provenance_step_id
 and valid_step.run_id = valid_run.id
on conflict do nothing;

insert into agent_memory_events (
  memory_id, user_id, event_type, actor_type, details
)
select
  memory.id,
  memory.user_id,
  case memory.status
    when 'candidate' then 'proposed'
    when 'rejected' then 'rejected'
    else 'confirmed'
  end,
  'system',
  jsonb_build_object('migration', '0076', 'source_trust', memory.source_trust)
from agent_memories memory
where not exists (
  select 1
  from agent_memory_events event
  where event.memory_id = memory.id
    and event.details @> '{"migration":"0076"}'::jsonb
);

create or replace function enforce_agent_memory_governance()
returns trigger
language plpgsql
as $$
declare
  replacement_status text;
begin
  -- Tool output is untrusted input, even when a caller bypasses the repository
  -- and supplies a seemingly verified status explicitly. Only a later user
  -- decision may move this row out of quarantine.
  if tg_op = 'INSERT'
    and new.source_trust = 'tool_derived' then
    new.status := 'candidate';
    new.verification_status := 'unverified';
    new.verified_at := null;
  end if;

  if tg_op = 'UPDATE' then
    if old.status in ('confirmed', 'rejected')
      and new.status is distinct from old.status then
      raise exception using
        errcode = '23514',
        constraint = 'agent_memories_terminal_status_immutable_check',
        message = 'a confirmed or rejected Agent memory cannot change status';
    end if;
  end if;

  if new.superseded_by is not null then
    if new.status <> 'confirmed' then
      raise exception using
        errcode = '23514',
        constraint = 'agent_memories_supersession_status_check',
        message = 'only a confirmed Agent memory can be superseded';
    end if;
    select status into replacement_status
    from agent_memories
    where id = new.superseded_by;
    if replacement_status is distinct from 'confirmed' then
      raise exception using
        errcode = '23514',
        constraint = 'agent_memories_replacement_status_check',
        message = 'replacement Agent memory must be confirmed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_memories_governance_trigger on agent_memories;
create trigger agent_memories_governance_trigger
before insert or update of status, superseded_by on agent_memories
for each row execute function enforce_agent_memory_governance();

-- Recall and deduplication must use the same confirmed-only active predicate.
drop index if exists agent_memories_scope_idx;
create index agent_memories_scope_idx
  on agent_memories(user_id, scope, scope_ref_id, created_at desc)
  where status = 'confirmed' and superseded_by is null and deleted_at is null;

drop index if exists agent_memories_dedupe_idx;
create unique index agent_memories_dedupe_idx
  on agent_memories(
    user_id,
    scope,
    coalesce(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    md5(content)
  )
  where status in ('candidate', 'confirmed')
    and superseded_by is null
    and deleted_at is null;

create index if not exists agent_memories_candidate_review_idx
  on agent_memories(user_id, created_at desc, id desc)
  where status = 'candidate' and superseded_by is null and deleted_at is null;

comment on table agent_memory_events is
  'Append-only Memory lifecycle and recall audit stream; event details never contain Memory content.';
comment on table agent_memory_evidence is
  'Bounded provenance links supporting one Memory without duplicating its payload.';
