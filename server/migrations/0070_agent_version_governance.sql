-- Make Agent configuration history independently verifiable and keep publishing
-- as an append-only governance event rather than only moving a mutable pointer.

alter table agent_versions
  add column if not exists configuration_hash text;
alter table agent_versions
  add column if not exists derived_from_version_id uuid;
alter table agent_versions
  add column if not exists change_kind text;

create or replace function compute_agent_version_configuration_hash(version_row agent_versions)
returns text
language sql
immutable
strict
as $$
  select encode(
    digest(
      convert_to(
        jsonb_build_object(
          'format_version', 1,
          'instructions', version_row.instructions,
          'model', version_row.model,
          'temperature', version_row.temperature,
          'max_iterations', version_row.max_iterations,
          'max_duration_ms', version_row.max_duration_ms,
          'max_output_tokens', version_row.max_output_tokens,
          'memory_mode', version_row.memory_mode,
          'response_format', version_row.response_format,
          'output_schema', version_row.output_schema,
          'approval_policy', version_row.approval_policy,
          'tool_bindings', version_row.tool_bindings,
          'welcome_message', version_row.welcome_message,
          'suggested_prompts', version_row.suggested_prompts
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

update agent_versions version_row
set configuration_hash = compute_agent_version_configuration_hash(version_row)
where configuration_hash is null
   or configuration_hash is distinct from compute_agent_version_configuration_hash(version_row);

update agent_versions
set change_kind = case when version = 1 then 'created' else 'edited' end
where change_kind is null;

with ancestry as (
  select
    id,
    lag(id) over (partition by agent_id order by version) as previous_version_id
  from agent_versions
)
update agent_versions version_row
set derived_from_version_id = ancestry.previous_version_id
from ancestry
where version_row.id = ancestry.id
  and version_row.version > 1
  and version_row.derived_from_version_id is null;

alter table agent_versions
  alter column configuration_hash set not null;
alter table agent_versions
  alter column change_kind set default 'edited';
alter table agent_versions
  alter column change_kind set not null;

alter table agent_versions
  drop constraint if exists agent_versions_configuration_hash_check;
alter table agent_versions
  add constraint agent_versions_configuration_hash_check
  check (configuration_hash ~ '^[0-9a-f]{64}$');

alter table agent_versions
  drop constraint if exists agent_versions_change_kind_check;
alter table agent_versions
  add constraint agent_versions_change_kind_check
  check (change_kind in ('created', 'edited', 'rollback'));

create unique index if not exists agent_versions_id_agent_unique_idx
  on agent_versions(id, agent_id);

alter table agent_versions
  drop constraint if exists agent_versions_derived_from_same_agent_fkey;
alter table agent_versions
  add constraint agent_versions_derived_from_same_agent_fkey
  foreign key (derived_from_version_id, agent_id)
  references agent_versions(id, agent_id)
  deferrable initially deferred;

create or replace function set_agent_version_configuration_hash()
returns trigger
language plpgsql
as $$
begin
  new.configuration_hash := compute_agent_version_configuration_hash(new);
  return new;
end;
$$;

drop trigger if exists agent_versions_configuration_hash_trigger on agent_versions;
create trigger agent_versions_configuration_hash_trigger
before insert on agent_versions
for each row execute function set_agent_version_configuration_hash();

create or replace function reject_agent_version_update()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = '23514',
    constraint = 'agent_versions_immutable_check',
    message = 'Agent versions are immutable; create a new version instead';
end;
$$;

drop trigger if exists agent_versions_immutable_trigger on agent_versions;
create trigger agent_versions_immutable_trigger
before update on agent_versions
for each row execute function reject_agent_version_update();

create table if not exists agent_version_publications (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  agent_version_id uuid not null,
  published_by uuid references users(id) on delete set null,
  release_notes text not null default '',
  validation_report jsonb not null,
  published_at timestamptz not null default now(),
  constraint agent_version_publications_version_agent_fkey
    foreign key (agent_version_id, agent_id)
    references agent_versions(id, agent_id)
    deferrable initially deferred,
  constraint agent_version_publications_release_notes_check
    check (char_length(release_notes) <= 4000),
  constraint agent_version_publications_validation_report_check
    check (
      jsonb_typeof(validation_report) = 'object'
      and jsonb_typeof(validation_report -> 'valid') = 'boolean'
      and jsonb_typeof(validation_report -> 'checks') = 'array'
    )
);

create index if not exists agent_version_publications_agent_published_idx
  on agent_version_publications(agent_id, published_at desc, id desc);
create index if not exists agent_version_publications_version_published_idx
  on agent_version_publications(agent_version_id, published_at desc, id desc);

comment on column agent_versions.configuration_hash is
  'SHA-256 of canonical jsonb containing every executable configuration field.';
comment on column agent_versions.derived_from_version_id is
  'The immutable version copied to produce this draft; rollback points to the restored historical version.';
comment on table agent_version_publications is
  'Append-only publication events with release notes and the exact pre-publish validation report.';
