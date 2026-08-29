-- Agent evaluation is a separate, fixture-backed execution plane. It pins
-- immutable Agent versions and dataset revisions while keeping every real
-- tool executor, Secret, production Run, approval and Memory table out of the
-- evaluation path.

create table if not exists agent_eval_datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text not null default '',
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_eval_datasets_name_check
    check (char_length(name) between 1 and 120),
  constraint agent_eval_datasets_description_check
    check (char_length(description) <= 1000),
  constraint agent_eval_datasets_revision_check
    check (revision >= 1),
  constraint agent_eval_datasets_id_user_unique unique (id, user_id)
);

create table if not exists agent_eval_cases (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null,
  user_id uuid not null,
  name text not null default '',
  input_text text not null,
  evaluation_spec jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_eval_cases_dataset_user_fkey
    foreign key (dataset_id, user_id)
    references agent_eval_datasets(id, user_id)
    on delete cascade,
  constraint agent_eval_cases_name_check
    check (char_length(name) <= 120),
  constraint agent_eval_cases_input_check
    check (char_length(input_text) between 1 and 16000),
  constraint agent_eval_cases_spec_check
    check (
      jsonb_typeof(evaluation_spec) = 'object'
      and evaluation_spec <> '{}'::jsonb
      and octet_length(evaluation_spec::text) <= 262144
    ),
  constraint agent_eval_cases_id_dataset_user_unique
    unique (id, dataset_id, user_id)
);

create or replace function bump_agent_eval_dataset_revision()
returns trigger
language plpgsql
as $$
begin
  update agent_eval_datasets
  set revision = revision + 1,
      updated_at = now()
  where id = coalesce(new.dataset_id, old.dataset_id)
    and user_id = coalesce(new.user_id, old.user_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists agent_eval_cases_revision_trigger on agent_eval_cases;
create trigger agent_eval_cases_revision_trigger
after insert or update or delete on agent_eval_cases
for each row execute function bump_agent_eval_dataset_revision();

create table if not exists agent_eval_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  dataset_id uuid not null,
  dataset_revision bigint not null,
  agent_id uuid not null references agents(id) on delete cascade,
  candidate_agent_version_id uuid not null,
  candidate_configuration_hash text not null,
  baseline_agent_version_id uuid,
  baseline_configuration_hash text,
  evaluator_version text not null,
  status text not null default 'queued',
  case_count integer not null,
  result_count integer not null default 0,
  failed_result_count integer not null default 0,
  aggregate_metrics jsonb not null default '{}'::jsonb,
  usage jsonb not null default '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}'::jsonb,
  validation_report jsonb not null,
  execution_snapshot jsonb not null,
  failure_code text,
  failure_message text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  queued_at timestamptz not null default now(),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  worker_id text,
  lease_token uuid,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  deadline_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_eval_runs_dataset_user_fkey
    foreign key (dataset_id, user_id)
    references agent_eval_datasets(id, user_id)
    on delete cascade,
  constraint agent_eval_runs_candidate_version_fkey
    foreign key (candidate_agent_version_id, agent_id)
    references agent_versions(id, agent_id),
  constraint agent_eval_runs_baseline_version_fkey
    foreign key (baseline_agent_version_id, agent_id)
    references agent_versions(id, agent_id),
  constraint agent_eval_runs_status_check
    check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  constraint agent_eval_runs_dataset_revision_check
    check (dataset_revision >= 1),
  constraint agent_eval_runs_configuration_hash_check
    check (
      candidate_configuration_hash ~ '^[0-9a-f]{64}$'
      and (
        (baseline_agent_version_id is null and baseline_configuration_hash is null)
        or (
          baseline_agent_version_id is not null
          and baseline_configuration_hash is not null
          and baseline_configuration_hash ~ '^[0-9a-f]{64}$'
          and baseline_agent_version_id <> candidate_agent_version_id
        )
      )
    ),
  constraint agent_eval_runs_evaluator_version_check
    check (evaluator_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  constraint agent_eval_runs_counts_check
    check (
      case_count between 1 and 100
      and result_count between 0 and case_count * 2
      and failed_result_count between 0 and result_count
    ),
  constraint agent_eval_runs_reports_check
    check (
      jsonb_typeof(aggregate_metrics) = 'object'
      and jsonb_typeof(validation_report) = 'object'
      and jsonb_typeof(execution_snapshot) = 'object'
      and octet_length(aggregate_metrics::text) <= 262144
      and octet_length(validation_report::text) <= 262144
      and octet_length(execution_snapshot::text) <= 262144
    ),
  constraint agent_eval_runs_usage_check
    check (
      jsonb_typeof(usage) = 'object'
      and usage ?& array['prompt_tokens', 'completion_tokens', 'total_tokens']
      and jsonb_typeof(usage -> 'prompt_tokens') = 'number'
      and jsonb_typeof(usage -> 'completion_tokens') = 'number'
      and jsonb_typeof(usage -> 'total_tokens') = 'number'
      and usage ->> 'prompt_tokens' ~ '^[0-9]+$'
      and usage ->> 'completion_tokens' ~ '^[0-9]+$'
      and usage ->> 'total_tokens' ~ '^[0-9]+$'
      and (usage ->> 'prompt_tokens')::bigint >= 0
      and (usage ->> 'completion_tokens')::bigint >= 0
      and (usage ->> 'total_tokens')::bigint >= 0
      and (usage ->> 'prompt_tokens')::bigint
        + (usage ->> 'completion_tokens')::bigint
        <= (usage ->> 'total_tokens')::bigint
    ),
  constraint agent_eval_runs_attempts_check
    check (attempts between 0 and max_attempts and max_attempts between 1 and 10),
  constraint agent_eval_runs_lease_check
    check (
      (lease_token is null and lease_expires_at is null and worker_id is null and claimed_at is null)
      or
      (lease_token is not null and lease_expires_at is not null and worker_id is not null and claimed_at is not null)
    ),
  constraint agent_eval_runs_failure_check
    check (
      failure_code is null
      or failure_code ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
  constraint agent_eval_runs_failure_message_check
    check (failure_message is null or char_length(failure_message) between 1 and 1000),
  constraint agent_eval_runs_terminal_check
    check (
      (
        status = 'queued'
        and completed_at is null
        and lease_token is null
        and failure_code is null
        and failure_message is null
      )
      or (
        status = 'running'
        and completed_at is null
        and lease_token is not null
        and failure_code is null
        and failure_message is null
      )
      or (
        status in ('completed', 'partial', 'cancelled')
        and completed_at is not null
        and lease_token is null
        and failure_code is null
        and failure_message is null
      )
      or (
        status = 'failed'
        and completed_at is not null
        and lease_token is null
        and failure_code is not null
        and failure_message is not null
      )
    )
);

create table if not exists agent_eval_run_cases (
  run_id uuid not null references agent_eval_runs(id) on delete cascade,
  case_id uuid not null,
  ordinal integer not null,
  name text not null default '',
  input_text text not null,
  evaluation_spec jsonb not null,
  case_created_at timestamptz not null,
  case_updated_at timestamptz not null,
  snapshotted_at timestamptz not null default now(),
  primary key (run_id, case_id),
  unique (run_id, ordinal),
  constraint agent_eval_run_cases_ordinal_check check (ordinal between 0 and 99),
  constraint agent_eval_run_cases_name_check check (char_length(name) <= 120),
  constraint agent_eval_run_cases_input_check check (char_length(input_text) between 1 and 16000),
  constraint agent_eval_run_cases_spec_check
    check (
      jsonb_typeof(evaluation_spec) = 'object'
      and evaluation_spec <> '{}'::jsonb
      and octet_length(evaluation_spec::text) <= 262144
    )
);

create table if not exists agent_eval_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_eval_runs(id) on delete cascade,
  case_id uuid not null,
  variant text not null,
  agent_id uuid not null,
  agent_version_id uuid not null,
  configuration_hash text not null,
  status text not null,
  output_text text not null default '',
  planned_tool_calls jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  usage jsonb not null default '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}'::jsonb,
  latency_ms integer not null default 0,
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  constraint agent_eval_results_run_case_fkey
    foreign key (run_id, case_id)
    references agent_eval_run_cases(run_id, case_id)
    on delete cascade,
  constraint agent_eval_results_version_agent_fkey
    foreign key (agent_version_id, agent_id)
    references agent_versions(id, agent_id),
  constraint agent_eval_results_run_case_variant_unique unique (run_id, case_id, variant),
  constraint agent_eval_results_variant_check check (variant in ('candidate', 'baseline')),
  constraint agent_eval_results_status_check check (status in ('succeeded', 'failed')),
  constraint agent_eval_results_configuration_hash_check
    check (configuration_hash ~ '^[0-9a-f]{64}$'),
  constraint agent_eval_results_output_check check (octet_length(output_text) <= 1048576),
  constraint agent_eval_results_tool_calls_check
    check (
      jsonb_typeof(planned_tool_calls) = 'array'
      and jsonb_array_length(planned_tool_calls) <= 24
      and octet_length(planned_tool_calls::text) <= 262144
    ),
  constraint agent_eval_results_metrics_check
    check (
      jsonb_typeof(metrics) = 'object'
      and octet_length(metrics::text) <= 262144
    ),
  constraint agent_eval_results_usage_check
    check (
      jsonb_typeof(usage) = 'object'
      and usage ?& array['prompt_tokens', 'completion_tokens', 'total_tokens']
      and jsonb_typeof(usage -> 'prompt_tokens') = 'number'
      and jsonb_typeof(usage -> 'completion_tokens') = 'number'
      and jsonb_typeof(usage -> 'total_tokens') = 'number'
      and usage ->> 'prompt_tokens' ~ '^[0-9]+$'
      and usage ->> 'completion_tokens' ~ '^[0-9]+$'
      and usage ->> 'total_tokens' ~ '^[0-9]+$'
      and (usage ->> 'prompt_tokens')::bigint >= 0
      and (usage ->> 'completion_tokens')::bigint >= 0
      and (usage ->> 'total_tokens')::bigint >= 0
      and (usage ->> 'prompt_tokens')::bigint
        + (usage ->> 'completion_tokens')::bigint
        <= (usage ->> 'total_tokens')::bigint
    ),
  constraint agent_eval_results_latency_check check (latency_ms >= 0),
  constraint agent_eval_results_terminal_check
    check (
      (status = 'succeeded' and failure_code is null and failure_message is null)
      or (
        status = 'failed'
        and failure_code is not null
        and failure_message is not null
        and failure_code ~ '^[a-z][a-z0-9_]{0,63}$'
        and char_length(failure_message) between 1 and 1000
      )
    )
);

create or replace function validate_agent_eval_run_versions()
returns trigger
language plpgsql
as $$
declare
  candidate_hash text;
  baseline_hash text;
  owner_id uuid;
begin
  select version.configuration_hash, agent.user_id
  into candidate_hash, owner_id
  from agent_versions version
  join agents agent on agent.id = version.agent_id
  where version.id = new.candidate_agent_version_id
    and version.agent_id = new.agent_id;

  if candidate_hash is null or owner_id is distinct from new.user_id then
    raise exception 'Agent eval candidate version is unavailable';
  end if;
  if candidate_hash is distinct from new.candidate_configuration_hash then
    raise exception 'Agent eval candidate configuration hash mismatch';
  end if;

  if new.baseline_agent_version_id is not null then
    select configuration_hash into baseline_hash
    from agent_versions
    where id = new.baseline_agent_version_id
      and agent_id = new.agent_id;
    if baseline_hash is null or baseline_hash is distinct from new.baseline_configuration_hash then
      raise exception 'Agent eval baseline configuration hash mismatch';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_eval_runs_version_guard on agent_eval_runs;
create trigger agent_eval_runs_version_guard
before insert on agent_eval_runs
for each row execute function validate_agent_eval_run_versions();

create or replace function protect_agent_eval_run_snapshot()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id
    or new.dataset_id is distinct from old.dataset_id
    or new.dataset_revision is distinct from old.dataset_revision
    or new.agent_id is distinct from old.agent_id
    or new.candidate_agent_version_id is distinct from old.candidate_agent_version_id
    or new.candidate_configuration_hash is distinct from old.candidate_configuration_hash
    or new.baseline_agent_version_id is distinct from old.baseline_agent_version_id
    or new.baseline_configuration_hash is distinct from old.baseline_configuration_hash
    or new.evaluator_version is distinct from old.evaluator_version
    or new.case_count is distinct from old.case_count
    or new.validation_report is distinct from old.validation_report
    or new.execution_snapshot is distinct from old.execution_snapshot
    or new.created_at is distinct from old.created_at then
    raise exception 'Agent eval execution snapshot is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_eval_runs_snapshot_guard on agent_eval_runs;
create trigger agent_eval_runs_snapshot_guard
before update on agent_eval_runs
for each row execute function protect_agent_eval_run_snapshot();

create or replace function reject_agent_eval_run_case_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Agent eval Case snapshot is immutable';
end;
$$;

drop trigger if exists agent_eval_run_cases_immutable_guard on agent_eval_run_cases;
create trigger agent_eval_run_cases_immutable_guard
before update on agent_eval_run_cases
for each row execute function reject_agent_eval_run_case_update();

create or replace function validate_agent_eval_result_variant()
returns trigger
language plpgsql
as $$
declare
  eval_run agent_eval_runs%rowtype;
begin
  select * into eval_run from agent_eval_runs where id = new.run_id;
  if eval_run.id is null or new.agent_id is distinct from eval_run.agent_id then
    raise exception 'Agent eval result Run or Agent mismatch';
  end if;
  if new.variant = 'candidate' and (
    new.agent_version_id is distinct from eval_run.candidate_agent_version_id
    or new.configuration_hash is distinct from eval_run.candidate_configuration_hash
  ) then
    raise exception 'Agent eval candidate result version mismatch';
  end if;
  if new.variant = 'baseline' and (
    eval_run.baseline_agent_version_id is null
    or new.agent_version_id is distinct from eval_run.baseline_agent_version_id
    or new.configuration_hash is distinct from eval_run.baseline_configuration_hash
  ) then
    raise exception 'Agent eval baseline result version mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_eval_results_variant_guard on agent_eval_results;
create trigger agent_eval_results_variant_guard
before insert or update on agent_eval_results
for each row execute function validate_agent_eval_result_variant();

create or replace function reject_agent_eval_result_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Agent eval result is immutable';
end;
$$;

drop trigger if exists agent_eval_results_immutable_guard on agent_eval_results;
create trigger agent_eval_results_immutable_guard
before update on agent_eval_results
for each row execute function reject_agent_eval_result_update();

create index if not exists agent_eval_datasets_user_updated_idx
  on agent_eval_datasets(user_id, updated_at desc, id desc);
create index if not exists agent_eval_cases_dataset_created_idx
  on agent_eval_cases(dataset_id, created_at, id);
create index if not exists agent_eval_runs_user_created_idx
  on agent_eval_runs(user_id, created_at desc, id desc);
create index if not exists agent_eval_runs_dispatch_idx
  on agent_eval_runs(status, coalesce(next_attempt_at, queued_at), created_at)
  where status in ('queued', 'running');
create unique index if not exists agent_eval_runs_active_without_baseline_unique_idx
  on agent_eval_runs(
    user_id, dataset_id, dataset_revision, agent_id, candidate_agent_version_id
  )
  where status in ('queued', 'running') and baseline_agent_version_id is null;
create unique index if not exists agent_eval_runs_active_with_baseline_unique_idx
  on agent_eval_runs(
    user_id, dataset_id, dataset_revision, agent_id,
    candidate_agent_version_id, baseline_agent_version_id
  )
  where status in ('queued', 'running') and baseline_agent_version_id is not null;
create index if not exists agent_eval_results_run_case_idx
  on agent_eval_results(run_id, case_id, variant);

comment on table agent_eval_runs is
  'Durable paired evaluations pinned to one dataset revision and immutable candidate/baseline Agent versions.';
comment on table agent_eval_results is
  'Fixture-backed Agent evaluation results. Tool plans are recorded, but no production tool executor is reachable.';
