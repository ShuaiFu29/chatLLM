import { createHash, randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { abortAgentRunsForProjectSpaceInProcess } from '../modules/agents/agent-run-control';
import { activeRunStatusPredicate } from './agentRuns';

export type CleanupResourceType =
  | 'file'
  | 'project_space'
  | 'account'
  | 'avatar'
  | 'conversion_generation';
export type CleanupJobStatus = 'queued' | 'processing' | 'waiting' | 'failed' | 'completed';

export interface CleanupJobRow {
  id: string;
  resource_key: string;
  resource_type: CleanupResourceType;
  resource_id: string;
  owner_user_id?: string | null;
  parent_job_id?: string | null;
  status: CleanupJobStatus;
  step_state: Record<string, boolean>;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  worker_id?: string | null;
  lease_token?: string | null;
  lease_expires_at?: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface CleanupJobClaim extends CleanupJobRow {
  lease_token: string;
  lease_expires_at: string;
}

export class CleanupLeaseLostError extends Error {
  constructor() {
    super('Artifact cleanup lease is no longer active');
    this.name = 'CleanupLeaseLostError';
  }
}

const columns = `
  id,
  resource_key,
  resource_type,
  resource_id,
  owner_user_id,
  parent_job_id,
  status,
  step_state,
  payload,
  attempts,
  max_attempts,
  next_attempt_at,
  worker_id,
  lease_token,
  lease_expires_at,
  last_error,
  created_at,
  updated_at,
  completed_at
`;

const cleanupResourceKey = (type: CleanupResourceType, resourceId: string) => (
  `${type}:${resourceId}`
);

const avatarCleanupResourceId = (objectKey: string) => (
  createHash('sha256').update(objectKey, 'utf8').digest('hex')
);

const insertCleanupJobWithClient = async (
  client: PoolClient,
  input: {
    resourceType: CleanupResourceType;
    resourceId: string;
    ownerUserId?: string | null;
    parentJobId?: string | null;
    payload?: Record<string, unknown>;
  }
) => {
  const { rows } = await client.query<CleanupJobRow>(
    `insert into artifact_cleanup_jobs (
       resource_key,
       resource_type,
       resource_id,
       owner_user_id,
       parent_job_id,
       payload
     )
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (resource_key) do update set
       owner_user_id = coalesce(artifact_cleanup_jobs.owner_user_id, excluded.owner_user_id),
       parent_job_id = coalesce(artifact_cleanup_jobs.parent_job_id, excluded.parent_job_id),
       payload = artifact_cleanup_jobs.payload || excluded.payload,
       updated_at = now()
     returning ${columns}`,
    [
      cleanupResourceKey(input.resourceType, input.resourceId),
      input.resourceType,
      input.resourceId,
      input.ownerUserId || null,
      input.parentJobId || null,
      JSON.stringify(input.payload || {}),
    ]
  );
  return rows[0];
};

interface ConversionGenerationCleanupRow {
  id: string;
  file_id: string;
  status: string;
  markdown_object_key?: string | null;
  source_map_object_key?: string | null;
  manifest_object_key?: string | null;
}

export const enqueueConversionGenerationCleanupWithClient = async (
  client: PoolClient,
  input: {
    fileId: string;
    generationId: string;
    ownerUserId: string;
    reason: string;
  },
) => {
  const { rows } = await client.query<ConversionGenerationCleanupRow>(
    `select
       generation.id,
       generation.file_id,
       generation.status,
       generation.markdown_object_key,
       generation.source_map_object_key,
       generation.manifest_object_key
     from file_conversion_generations generation
     join files target_file on target_file.id = generation.file_id
     where generation.id = $1::uuid
       and generation.file_id = $2::uuid
       and target_file.active_conversion_generation_id is distinct from generation.id
     for update of generation, target_file`,
    [input.generationId, input.fileId],
  );
  let generation = rows[0];
  if (!generation) return null;

  if (generation.status === 'converting') {
    const retired = await client.query<ConversionGenerationCleanupRow>(
      `update file_conversion_generations
       set status = 'failed',
           error_code = 'INGESTION_ATTEMPT_TERMINATED',
           completed_at = coalesce(completed_at, now()),
           updated_at = now()
       where id = $1::uuid
         and file_id = $2::uuid
         and status = 'converting'
       returning
         id,
         file_id,
         status,
         markdown_object_key,
         source_map_object_key,
         manifest_object_key`,
      [input.generationId, input.fileId],
    );
    generation = retired.rows[0];
  } else if (['completed', 'completed_with_warnings'].includes(generation.status)) {
    const retired = await client.query<ConversionGenerationCleanupRow>(
      `update file_conversion_generations
       set status = 'superseded',
           updated_at = now()
       where id = $1::uuid
         and file_id = $2::uuid
         and status in ('completed', 'completed_with_warnings')
       returning
         id,
         file_id,
         status,
         markdown_object_key,
         source_map_object_key,
         manifest_object_key`,
      [input.generationId, input.fileId],
    );
    generation = retired.rows[0];
  }

  if (!generation || !['failed', 'superseded'].includes(generation.status)) return null;
  const storageObjectKeys = uniqueStorageObjectKeys([
    generation.markdown_object_key,
    generation.source_map_object_key,
    generation.manifest_object_key,
  ]);
  return insertCleanupJobWithClient(client, {
    resourceType: 'conversion_generation',
    resourceId: generation.id,
    ownerUserId: input.ownerUserId,
    payload: {
      file_id: generation.file_id,
      reason: input.reason,
      storage_object_keys: storageObjectKeys,
    },
  });
};

interface FileCleanupSource {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  object_key?: string | null;
}

interface MultipartCleanupSource {
  object_key: string;
  storage_upload_id: string;
  status: string;
}

interface ConversionGenerationCleanupSource {
  status: string;
  source_object_key?: string | null;
  markdown_object_key?: string | null;
  source_map_object_key?: string | null;
  manifest_object_key?: string | null;
}

const uniqueStorageObjectKeys = (values: unknown[]) => Array.from(new Set(
  values.filter((value): value is string => typeof value === 'string' && value.length > 0),
));

const prepareFileCleanupWithClient = async (
  client: PoolClient,
  file: FileCleanupSource,
  parentJobId?: string | null
) => {
  await client.query(
    `update files
     set status = 'deleting',
         error_message = null,
         next_attempt_at = null,
         updated_at = now()
     where id = $1
       and user_id = $2`,
    [file.id, file.user_id]
  );

  // Deletion visibility must not wait for the async cleanup worker. The RAG
  // exact-cache key embeds `project_spaces.knowledge_version`, so bumping it in
  // the same transaction that marks the file `deleting` retires every cached
  // answer that could still quote this document. The worker's later
  // `/cleanup-file` bump stays harmless (versions only move forward).
  if (file.project_space_id) {
    await client.query(
      `update project_spaces
       set knowledge_version = knowledge_version + 1,
           knowledge_version_updated_at = now(),
           updated_at = now()
       where id = $1 and user_id = $2`,
      [file.project_space_id, file.user_id],
    );
    await client.query(
      `delete from rag_retrieval_cache
       where user_id = $1 and project_space_id = $2`,
      [file.user_id, file.project_space_id],
    );
  }

  await client.query(
    `update file_ingestion_jobs
     set status = 'cancelled',
         stage = 'cancelled',
         error_message = 'Deletion requested',
         completed_at = now(),
         heartbeat_at = now(),
         lease_expires_at = now(),
         updated_at = now()
     where file_id = $1
       and status in ('queued', 'processing')`,
    [file.id]
  );

  const { rows: generationRows } = await client.query<ConversionGenerationCleanupSource>(
    `select
       status,
       source_object_key,
       markdown_object_key,
       source_map_object_key,
       manifest_object_key
     from file_conversion_generations
     where file_id = $1
     for update`,
    [file.id]
  );

  const { rows: multipartRows } = await client.query<MultipartCleanupSource>(
    `select object_key, storage_upload_id, status
     from upload_multipart_sessions
     where file_id = $1
     for update`,
    [file.id]
  );
  const multipart = multipartRows[0];

  await client.query(
    `update upload_multipart_sessions
     set status = 'cancelling',
         error_message = 'Deletion requested',
         updated_at = now()
     where file_id = $1
       and status in ('initiated', 'uploading')`,
    [file.id]
  );

  const multipartIsActive = Boolean(
    multipart && ['initiated', 'uploading', 'completing', 'cancelling'].includes(multipart.status)
  );
  const storageObjectKeys = uniqueStorageObjectKeys([
    file.object_key,
    multipart?.object_key,
    ...generationRows.flatMap((generation) => [
      generation.source_object_key,
      generation.markdown_object_key,
      generation.source_map_object_key,
      generation.manifest_object_key,
    ]),
  ]);
  return insertCleanupJobWithClient(client, {
    resourceType: 'file',
    resourceId: file.id,
    ownerUserId: file.user_id,
    parentJobId,
    payload: {
      storage_object_keys: storageObjectKeys,
      object_key: file.object_key || null,
      multipart_object_key: multipart?.object_key || null,
      multipart_upload_id: multipartIsActive ? multipart?.storage_upload_id : null,
    },
  });
};

interface EnqueueOptions {
  runInTransaction?: typeof withTransaction;
}

export const enqueueAvatarCleanupWithClient = async (
  client: PoolClient,
  objectKey: string
) => {
  if (!objectKey) throw new Error('Avatar cleanup object key is required');
  const resourceId = avatarCleanupResourceId(objectKey);
  const { rows } = await client.query<CleanupJobRow>(
    `insert into artifact_cleanup_jobs (
       resource_key,
       resource_type,
       resource_id,
       payload
     )
     values ($1, 'avatar', $2, jsonb_build_object('object_key', $3::text))
     on conflict (resource_key) do update set
       status = 'queued',
       step_state = artifact_cleanup_jobs.step_state - 'storage_deleted' - 'finalized',
       payload = artifact_cleanup_jobs.payload || jsonb_build_object('object_key', $3::text),
       attempts = case
         when artifact_cleanup_jobs.attempts >= artifact_cleanup_jobs.max_attempts then 0
         else artifact_cleanup_jobs.attempts
       end,
       next_attempt_at = null,
       worker_id = null,
       lease_token = null,
       lease_expires_at = null,
       last_error = '',
       completed_at = null,
       updated_at = now()
     returning ${columns}`,
    [cleanupResourceKey('avatar', resourceId), resourceId, objectKey]
  );
  if (!rows[0]) throw new Error('Avatar cleanup could not be queued');
  return rows[0];
};

export const enqueueAvatarCleanup = async (
  objectKey: string,
  options: EnqueueOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction((client) => enqueueAvatarCleanupWithClient(client, objectKey));
};

export const enqueueFileCleanup = async (
  fileId: string,
  userId: string,
  options: EnqueueOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    const owner = await client.query<{ id: string }>(
      `select id
       from users
       where id = $1
         and deletion_status = 'active'
       for update`,
      [userId]
    );
    if (!owner.rows[0]) return null;

    const { rows } = await client.query<FileCleanupSource>(
      `select id, user_id, project_space_id, object_key
       from files
       where id = $1 and user_id = $2
       for update`,
      [fileId, userId]
    );
    const file = rows[0];
    if (!file) {
      const existing = await client.query<CleanupJobRow>(
        `select ${columns}
         from artifact_cleanup_jobs
         where resource_key = $1`,
        [cleanupResourceKey('file', fileId)]
      );
      return existing.rows[0] || null;
    }

    return prepareFileCleanupWithClient(client, file);
  });
};

const PROJECT_SPACE_AGENT_CANCEL_REASON = 'Project space cleanup cancelled the Agent run';

const cancelProjectSpaceAgentRunsWithClient = async (
  client: PoolClient,
  projectSpaceId: string,
  userId: string,
) => {
  const { rows: activeRuns } = await client.query<{
    id: string;
    conversation_id: string;
    assistant_message_id?: string | null;
  }>(
    `update agent_runs
     set status = 'cancelled', completed_at = now(),
         error_code = 'agent_run_cancelled',
         error_message = $2,
         lease_token = null, lease_expires_at = null
     where user_id = $1
       and conversation_id in (
         select id from conversations where project_space_id = $3::uuid
       )
       and ${activeRunStatusPredicate()}
     returning id, conversation_id, assistant_message_id`,
    [userId, PROJECT_SPACE_AGENT_CANCEL_REASON, projectSpaceId],
  );
  abortAgentRunsForProjectSpaceInProcess(projectSpaceId, userId, PROJECT_SPACE_AGENT_CANCEL_REASON);
  if (activeRuns.length === 0) return;

  const runIds = activeRuns.map((run) => run.id);
  await client.query(
    `update agent_approvals
     set status = 'expired', decided_at = now(), reason = $2
     where status = 'pending'
       and (run_id = any($1::uuid[]) or requested_by_run_id = any($1::uuid[]))`,
    [runIds, PROJECT_SPACE_AGENT_CANCEL_REASON],
  );
  for (const run of activeRuns) {
    // Only fill an existing placeholder. A null id means the message was
    // already deleted, and inserting a replacement would recreate a row in a
    // conversation that this cleanup is about to remove.
    if (!run.assistant_message_id) continue;
    await client.query(
      `update messages
       set content = $2
       where id = $1 and conversation_id = $3 and role = 'assistant'
         and content = ''`,
      [run.assistant_message_id, `${PROJECT_SPACE_AGENT_CANCEL_REASON}.`, run.conversation_id],
    );
  }
  await client.query(
    `update agent_steps
     set status = 'cancelled',
         output = case
           when output is null then jsonb_build_object('reason', $2)
           else output || jsonb_build_object('reason', $2)
         end
     where run_id = any($1::uuid[]) and status in ('pending', 'running')`,
    [runIds, PROJECT_SPACE_AGENT_CANCEL_REASON],
  );
};

export const enqueueProjectSpaceCleanup = async (
  projectSpaceId: string,
  userId: string,
  options: EnqueueOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    const owner = await client.query<{ id: string }>(
      `select id
       from users
       where id = $1
         and deletion_status = 'active'
       for update`,
      [userId]
    );
    if (!owner.rows[0]) return null;

    const { rows: spaceRows } = await client.query<{ id: string; is_default: boolean }>(
      `select id, is_default
       from project_spaces
       where id = $1 and user_id = $2
       for update`,
      [projectSpaceId, userId]
    );
    const space = spaceRows[0];
    if (!space || space.is_default) return null;

    await client.query(
      `update project_spaces
       set status = 'deleting',
           updated_at = now()
       where id = $1 and user_id = $2 and is_default = false`,
      [projectSpaceId, userId]
    );
    await cancelProjectSpaceAgentRunsWithClient(client, projectSpaceId, userId);
    const parent = await insertCleanupJobWithClient(client, {
      resourceType: 'project_space',
      resourceId: projectSpaceId,
      ownerUserId: userId,
    });

    const { rows: files } = await client.query<FileCleanupSource>(
      `select id, user_id, project_space_id, object_key
       from files
       where user_id = $1 and project_space_id = $2
       order by id
       for update`,
      [userId, projectSpaceId]
    );
    for (const file of files) {
      await prepareFileCleanupWithClient(client, file, parent.id);
    }

    return { job: parent, childCount: files.length };
  });
};

export const enqueueAccountCleanup = async (
  userId: string,
  options: EnqueueOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    const { rows: userRows } = await client.query<{
      id: string;
      avatar_object_key?: string | null;
    }>(
      `select id, avatar_object_key
       from users
       where id = $1
       for update`,
      [userId]
    );
    const user = userRows[0];
    if (!user) return null;

    await client.query(
      `update users
       set deletion_status = 'pending'
       where id = $1`,
      [userId]
    );
    await client.query(
      `delete from sessions
       where user_id = $1`,
      [userId]
    );
    const parent = await insertCleanupJobWithClient(client, {
      resourceType: 'account',
      resourceId: userId,
      ownerUserId: userId,
      payload: { avatar_object_key: user.avatar_object_key || null },
    });

    const { rows: files } = await client.query<FileCleanupSource>(
      `select id, user_id, project_space_id, object_key
       from files
       where user_id = $1
       order by id
       for update`,
      [userId]
    );
    for (const file of files) {
      await prepareFileCleanupWithClient(client, file, parent.id);
    }

    return { job: parent, childCount: files.length };
  });
};

interface ClaimCleanupJobOptions {
  cleanupJobId?: string;
  leaseDurationMs?: number;
  runInTransaction?: typeof withTransaction;
  createId?: () => string;
}

export const claimNextCleanupJob = async (
  workerId: string,
  options: ClaimCleanupJobOptions = {}
) => {
  const leaseDurationMs = options.leaseDurationMs ?? 15 * 60 * 1000;
  const runInTransaction = options.runInTransaction || withTransaction;
  const createId = options.createId || randomUUID;

  return runInTransaction(async (client): Promise<CleanupJobClaim | null> => {
    const { rows } = await client.query<CleanupJobRow>(
      `select ${columns}
       from artifact_cleanup_jobs
       where ($1::uuid is null or id = $1::uuid)
       and ((
          status in ('queued', 'waiting')
          and (next_attempt_at is null or next_attempt_at <= now())
       ) or (
         status = 'failed'
         and attempts < max_attempts
         and next_attempt_at <= now()
       ) or (
         status = 'processing'
          and attempts < max_attempts
          and lease_expires_at <= now()
       ))
       order by created_at asc
       limit 1
       for update skip locked`,
      [options.cleanupJobId || null]
    );
    const candidate = rows[0];
    if (!candidate) return null;

    const leaseToken = createId();
    const claimed = await client.query<CleanupJobClaim>(
      `update artifact_cleanup_jobs
       set status = 'processing',
           attempts = attempts + case when status = 'waiting' then 0 else 1 end,
           worker_id = $2,
           lease_token = $3,
           lease_expires_at = now() + ($4::double precision * interval '1 millisecond'),
           next_attempt_at = null,
           updated_at = now()
       where id = $1
       returning ${columns}`,
      [candidate.id, workerId, leaseToken, leaseDurationMs]
    );
    return claimed.rows[0] || null;
  });
};

export const claimCleanupJobById = async (
  cleanupJobId: string,
  workerId: string,
  options: Omit<ClaimCleanupJobOptions, 'cleanupJobId'> = {}
) => claimNextCleanupJob(workerId, { ...options, cleanupJobId });

export const listDispatchableCleanupJobIds = async (
  limit = 50,
  runQuery: typeof query = query
) => {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const { rows } = await runQuery<{ id: string }>(
    `select id
     from artifact_cleanup_jobs
     where (
       status in ('queued', 'waiting')
       and (next_attempt_at is null or next_attempt_at <= now())
     ) or (
       status = 'failed'
       and attempts < max_attempts
       and next_attempt_at <= now()
     ) or (
       status = 'processing'
       and attempts < max_attempts
       and lease_expires_at <= now()
     )
     order by created_at asc
     limit $1`,
    [boundedLimit]
  );
  return rows.map((row) => row.id);
};

interface FailExhaustedCleanupJobsOptions {
  limit?: number;
  runQuery?: typeof query;
}

export const failExhaustedCleanupJobs = async (
  options: FailExhaustedCleanupJobsOptions = {}
) => {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const runQuery = options.runQuery || query;
  const { rows } = await runQuery<{ id: string }>(
    `with exhausted as (
       select id
       from artifact_cleanup_jobs
       where status = 'processing'
         and attempts >= max_attempts
         and lease_expires_at <= now()
       order by lease_expires_at asc
       limit $1
       for update skip locked
     )
     update artifact_cleanup_jobs job
     set status = 'failed',
         next_attempt_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         last_error = 'Artifact cleanup lease expired after maximum attempts',
         updated_at = now()
     from exhausted
     where job.id = exhausted.id
     returning job.id`,
    [limit]
  );
  return rows.length;
};

interface CleanupLeaseOptions {
  leaseDurationMs?: number;
  runQuery?: typeof query;
}

export const renewCleanupJobLease = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token'>,
  options: CleanupLeaseOptions = {}
) => {
  const leaseDurationMs = options.leaseDurationMs ?? 15 * 60 * 1000;
  const runQuery = options.runQuery || query;
  const { rows } = await runQuery<CleanupJobRow>(
    `update artifact_cleanup_jobs
     set lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
         updated_at = now()
     where id = $1
       and lease_token = $2
       and status = 'processing'
       and lease_expires_at > now()
     returning ${columns}`,
    [claim.id, claim.lease_token, leaseDurationMs]
  );
  return rows[0] || null;
};

interface CleanupMutationOptions {
  runQuery?: typeof query;
}

const requireCleanupMutation = (job?: CleanupJobRow | null) => {
  if (!job) throw new CleanupLeaseLostError();
  return job;
};

export const updateCleanupJobStep = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token'>,
  step: string,
  options: CleanupMutationOptions = {}
) => {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(step)) throw new Error('Invalid cleanup step key');
  const runQuery = options.runQuery || query;
  const { rows } = await runQuery<CleanupJobRow>(
    `update artifact_cleanup_jobs
     set step_state = jsonb_set(step_state, array[$2]::text[], 'true'::jsonb, true),
         updated_at = now()
     where id = $1
       and lease_token = $3
       and status = 'processing'
       and lease_expires_at > now()
     returning ${columns}`,
    [claim.id, step, claim.lease_token]
  );
  return requireCleanupMutation(rows[0]);
};

export const markCleanupJobWaiting = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token'>,
  delayMs = 1000,
  options: CleanupMutationOptions = {}
) => {
  const runQuery = options.runQuery || query;
  const { rows } = await runQuery<CleanupJobRow>(
    `update artifact_cleanup_jobs
     set status = 'waiting',
         next_attempt_at = now() + ($3::double precision * interval '1 millisecond'),
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         last_error = '',
         updated_at = now()
     where id = $1
       and lease_token = $2
       and status = 'processing'
       and lease_expires_at > now()
     returning ${columns}`,
    [claim.id, claim.lease_token, delayMs]
  );
  return requireCleanupMutation(rows[0]);
};

export const markCleanupJobFailed = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token'>,
  safeError: string,
  retryBaseDelayMs = 60 * 1000,
  options: CleanupMutationOptions = {}
) => {
  const runQuery = options.runQuery || query;
  const message = safeError.slice(0, 500);
  const { rows } = await runQuery<CleanupJobRow>(
    `update artifact_cleanup_jobs
     set status = 'failed',
         next_attempt_at = case
           when attempts >= max_attempts then null
           else now() + (
             least(
               3600000::double precision,
               $4::double precision * power(2, greatest(attempts - 1, 0))
             ) * interval '1 millisecond'
           )
         end,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         last_error = $3,
         updated_at = now()
     where id = $1
       and lease_token = $2
       and status = 'processing'
       and lease_expires_at > now()
     returning ${columns}`,
    [claim.id, claim.lease_token, message, retryBaseDelayMs]
  );
  return requireCleanupMutation(rows[0]);
};

export const getCleanupChildSummary = async (
  parentJobId: string,
  runQuery: typeof query = query
) => {
  const { rows } = await runQuery<{ pending: number | string; failed: number | string }>(
    `select
       count(*) filter (where status <> 'completed')::int as pending,
       count(*) filter (
         where status = 'failed'
           and attempts >= max_attempts
           and next_attempt_at is null
       )::int as failed
     from artifact_cleanup_jobs
     where parent_job_id = $1`,
    [parentJobId]
  );
  return {
    pending: Number(rows[0]?.pending || 0),
    failed: Number(rows[0]?.failed || 0),
  };
};

const lockCurrentCleanupJob = async (
  client: PoolClient,
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token'>
) => {
  const { rows } = await client.query<CleanupJobRow>(
    `select ${columns}
     from artifact_cleanup_jobs
     where id = $1
       and lease_token = $2
       and status = 'processing'
       and lease_expires_at > now()
     for update`,
    [claim.id, claim.lease_token]
  );
  return requireCleanupMutation(rows[0]);
};

const completeLockedCleanupJob = async (client: PoolClient, jobId: string) => {
  const { rows } = await client.query<CleanupJobRow>(
    `update artifact_cleanup_jobs
     set status = 'completed',
         step_state = jsonb_set(step_state, '{finalized}', 'true'::jsonb, true),
         next_attempt_at = null,
         worker_id = null,
         lease_token = null,
         lease_expires_at = null,
         last_error = '',
         completed_at = now(),
         updated_at = now()
     where id = $1
     returning ${columns}`,
    [jobId]
  );
  return rows[0];
};

interface FinalizeCleanupOptions {
  runInTransaction?: typeof withTransaction;
}

export const finalizeFileCleanup = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token' | 'resource_id'>,
  options: FinalizeCleanupOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    await client.query('select id from files where id = $1::uuid for update', [claim.resource_id]);
    const job = await lockCurrentCleanupJob(client, claim);
    if (job.resource_type !== 'file' || job.resource_id !== claim.resource_id) {
      throw new CleanupLeaseLostError();
    }
    await client.query('delete from files where id = $1::uuid', [claim.resource_id]);
    return completeLockedCleanupJob(client, job.id);
  });
};

const requireCompletedChildren = async (client: PoolClient, parentJobId: string) => {
  const { rows } = await client.query<{ incomplete: boolean }>(
    `select exists (
       select 1
       from artifact_cleanup_jobs
       where parent_job_id = $1
         and status <> 'completed'
     ) as incomplete`,
    [parentJobId]
  );
  if (rows[0]?.incomplete) throw new Error('Cleanup child jobs are incomplete');
};

export const finalizeProjectSpaceCleanup = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token' | 'resource_id'>,
  options: FinalizeCleanupOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    await client.query(
      'select id from project_spaces where id = $1::uuid for update',
      [claim.resource_id]
    );
    const job = await lockCurrentCleanupJob(client, claim);
    if (job.resource_type !== 'project_space' || job.resource_id !== claim.resource_id) {
      throw new CleanupLeaseLostError();
    }
    await requireCompletedChildren(client, job.id);

    if (job.owner_user_id) {
      await cancelProjectSpaceAgentRunsWithClient(client, job.resource_id, job.owner_user_id);
    }

    // Agent versions are immutable execution records. Project-scoped Agents are
    // deleted below (and their versions cascade with them), so rewriting every
    // historical binding before that delete only destroyed reproducibility.
    // Legacy out-of-scope JSON references do not carry a foreign key and cannot
    // block deleting the project tools.
    await client.query(
      `delete from agents where project_space_id = $1::uuid`,
      [claim.resource_id],
    );
    await client.query(
      `delete from agent_tools where project_space_id = $1::uuid`,
      [claim.resource_id],
    );
    await client.query(
      `delete from conversations
       where project_space_id = $1::uuid`,
      [claim.resource_id]
    );
    await client.query(
      `delete from project_spaces
       where id = $1::uuid
         and is_default = false`,
      [claim.resource_id]
    );
    return completeLockedCleanupJob(client, job.id);
  });
};

export const finalizeAccountCleanup = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token' | 'resource_id'>,
  options: FinalizeCleanupOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    await client.query('select id from users where id = $1::uuid for update', [claim.resource_id]);
    const job = await lockCurrentCleanupJob(client, claim);
    if (job.resource_type !== 'account' || job.resource_id !== claim.resource_id) {
      throw new CleanupLeaseLostError();
    }
    await requireCompletedChildren(client, job.id);
    await client.query('delete from users where id = $1::uuid', [claim.resource_id]);
    return completeLockedCleanupJob(client, job.id);
  });
};

export const finalizeAvatarCleanup = async (
  claim: Pick<CleanupJobClaim, 'id' | 'lease_token' | 'resource_id'>,
  options: FinalizeCleanupOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    const job = await lockCurrentCleanupJob(client, claim);
    if (job.resource_type !== 'avatar' || job.resource_id !== claim.resource_id) {
      throw new CleanupLeaseLostError();
    }
    return completeLockedCleanupJob(client, job.id);
  });
};

export const finalizeConversionGenerationCleanup = async (
  claim: Pick<
    CleanupJobClaim,
    'id' | 'lease_token' | 'resource_id' | 'payload'
  >,
  options: FinalizeCleanupOptions = {},
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    const payloadFileId = typeof claim.payload?.file_id === 'string'
      ? claim.payload.file_id
      : '';
    if (!payloadFileId) throw new Error('Conversion generation cleanup file id is missing');

    await client.query(
      'select id from files where id = $1::uuid for update',
      [payloadFileId],
    );
    const generationResult = await client.query<{
      id: string;
      file_id: string;
      status: string;
      active_conversion_generation_id?: string | null;
    }>(
      `select
         generation.id,
         generation.file_id,
         generation.status,
         target_file.active_conversion_generation_id
       from file_conversion_generations generation
       join files target_file on target_file.id = generation.file_id
       where generation.id = $1::uuid
         and generation.file_id = $2::uuid
       for update of generation`,
      [claim.resource_id, payloadFileId],
    );
    const generation = generationResult.rows[0];
    const job = await lockCurrentCleanupJob(client, claim);
    if (
      job.resource_type !== 'conversion_generation'
      || job.resource_id !== claim.resource_id
    ) {
      throw new CleanupLeaseLostError();
    }

    if (generation) {
      if (generation.active_conversion_generation_id === generation.id) {
        throw new Error('Active conversion generation cannot be finalized');
      }
      if (!['failed', 'superseded'].includes(generation.status)) {
        throw new Error('Conversion generation is not cleanup-safe');
      }
      await client.query(
        `delete from file_conversion_generations
         where id = $1::uuid
           and file_id = $2::uuid`,
        [claim.resource_id, payloadFileId],
      );
    }
    return completeLockedCleanupJob(client, job.id);
  });
};
