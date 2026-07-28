import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import type { DocumentKind } from '../lib/uploadInput';

export interface FileRow {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  filename: string;
  file_hash: string;
  file_size?: number | null;
  file_type?: string | null;
  document_kind?: DocumentKind;
  declared_mime_type?: string | null;
  detected_mime_type?: string | null;
  active_conversion_generation_id?: string | null;
  conversion_warning_count?: number;
  object_key?: string | null;
  status: 'uploading' | 'pending' | 'processing' | 'completed' | 'failed' | 'deleting';
  progress: number;
  error_message?: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_attempt_at?: string | null;
  reserved_bytes: number | string;
  storage_bytes: number | string;
  created_at: string;
  updated_at: string;
}

const columns = `
  id,
  user_id,
  project_space_id,
  filename,
  file_hash,
  file_size,
  file_type,
  document_kind,
  declared_mime_type,
  detected_mime_type,
  active_conversion_generation_id,
  conversion_warning_count,
  object_key,
  status,
  progress,
  error_message,
  attempts,
  max_attempts,
  next_attempt_at,
  last_attempt_at,
  reserved_bytes,
  storage_bytes,
  created_at,
  updated_at
`;

const claimedColumns = `
  file.id,
  file.user_id,
  file.project_space_id,
  file.filename,
  file.file_hash,
  file.file_size,
  file.file_type,
  file.document_kind,
  file.declared_mime_type,
  file.detected_mime_type,
  file.active_conversion_generation_id,
  file.conversion_warning_count,
  file.object_key,
  file.status,
  file.progress,
  file.error_message,
  file.attempts,
  file.max_attempts,
  file.next_attempt_at,
  file.last_attempt_at,
  file.reserved_bytes,
  file.storage_bytes,
  file.created_at,
  file.updated_at
`;

export const getFileContentScopeKey = (projectSpaceId?: string | null) => (
  projectSpaceId || '__global__'
);

const findClaimedFileWithClient = async (
  client: PoolClient,
  userId: string,
  hash: string,
  projectSpaceId?: string | null,
  conversionProfile = 'markdown-v1'
) => {
  const { rows } = await client.query<FileRow>(
    `select ${claimedColumns}
     from file_content_claims claim
     join files file on file.id = claim.file_id
     where claim.user_id = $1
       and claim.scope_key = $2
       and claim.file_hash = $3
       and claim.conversion_profile = $4`,
    [userId, getFileContentScopeKey(projectSpaceId), hash, conversionProfile]
  );
  return rows[0] || null;
};

export const findClaimedFileByUserAndHash = async (
  userId: string,
  hash: string,
  projectSpaceId?: string | null,
  conversionProfile = 'markdown-v1'
) => {
  const { rows } = await query<FileRow>(
    `select ${claimedColumns}
     from file_content_claims claim
     join files file on file.id = claim.file_id
     where claim.user_id = $1
       and claim.scope_key = $2
       and claim.file_hash = $3
       and claim.conversion_profile = $4`,
    [userId, getFileContentScopeKey(projectSpaceId), hash, conversionProfile]
  );
  return rows[0] || null;
};

export const findCompletedFileByUserAndHash = async (
  userId: string,
  hash: string,
  projectSpaceId?: string | null,
  conversionProfile = 'markdown-v1'
) => {
  const file = await findClaimedFileByUserAndHash(userId, hash, projectSpaceId, conversionProfile);
  return file?.status === 'completed' ? file : null;
};

export const findUploadingFileByUserAndHash = async (
  userId: string,
  hash: string,
  projectSpaceId?: string | null,
  conversionProfile = 'markdown-v1'
) => {
  const file = await findClaimedFileByUserAndHash(userId, hash, projectSpaceId, conversionProfile);
  return file?.status === 'uploading' ? { id: file.id } : null;
};

export interface UploadReservationInput {
  userId: string;
  filename: string;
  hash: string;
  size: number;
  type?: string;
  declaredMimeType?: string;
  documentKind?: DocumentKind;
  conversionProfile?: string;
  projectSpaceId?: string | null;
}

export interface UploadQuotaLimits {
  maxDocumentBytes: number;
  maxUserStorageBytes: number;
  maxUserActiveUploadBytes: number;
}

export interface ReserveUploadFileOptions {
  limits?: UploadQuotaLimits;
  runInTransaction?: typeof withTransaction;
}

export type UploadReservationErrorCode =
  | 'DOCUMENT_TOO_LARGE'
  | 'USER_STORAGE_QUOTA_EXCEEDED'
  | 'ACTIVE_UPLOAD_QUOTA_EXCEEDED'
  | 'UPLOAD_USER_NOT_FOUND'
  | 'UPLOAD_PROJECT_NOT_FOUND';

export class UploadReservationError extends Error {
  constructor(readonly code: UploadReservationErrorCode) {
    super(code);
    this.name = 'UploadReservationError';
  }
}

const defaultUploadQuotaLimits = (): UploadQuotaLimits => ({
  maxDocumentBytes: serverEnv.MAX_DOCUMENT_BYTES,
  maxUserStorageBytes: serverEnv.MAX_USER_STORAGE_BYTES,
  maxUserActiveUploadBytes: serverEnv.MAX_USER_ACTIVE_UPLOAD_BYTES,
});

const toByteCount = (value: unknown) => {
  const parsed = BigInt(String(value ?? 0));
  if (parsed < 0n) throw new Error('Invalid negative upload accounting value');
  return parsed;
};

const ensureQuotaAvailable = async (
  client: PoolClient,
  userId: string,
  additionalBytes: number,
  limits: UploadQuotaLimits
) => {
  const { rows } = await client.query<{ storage_bytes: string; reserved_bytes: string }>(
    `select
       coalesce(sum(storage_bytes), 0)::text as storage_bytes,
       coalesce(sum(reserved_bytes), 0)::text as reserved_bytes
     from files
     where user_id = $1
       and (reserved_bytes > 0 or storage_bytes > 0)`,
    [userId]
  );
  const storageBytes = toByteCount(rows[0]?.storage_bytes);
  const reservedBytes = toByteCount(rows[0]?.reserved_bytes);
  const requestedBytes = BigInt(additionalBytes);

  if (reservedBytes + requestedBytes > BigInt(limits.maxUserActiveUploadBytes)) {
    throw new UploadReservationError('ACTIVE_UPLOAD_QUOTA_EXCEEDED');
  }
  if (storageBytes + reservedBytes + requestedBytes > BigInt(limits.maxUserStorageBytes)) {
    throw new UploadReservationError('USER_STORAGE_QUOTA_EXCEEDED');
  }
};

export const reserveUploadFile = async (
  input: UploadReservationInput,
  options: ReserveUploadFileOptions = {}
) => {
  const limits = options.limits || defaultUploadQuotaLimits();
  const documentKind = input.documentKind || 'markdown';
  const conversionProfile = input.conversionProfile || 'markdown-v1';
  if (!Number.isSafeInteger(input.size) || input.size < 1) {
    throw new Error('Invalid upload size');
  }
  if (input.size > limits.maxDocumentBytes) {
    throw new UploadReservationError('DOCUMENT_TOO_LARGE');
  }

  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `select id
       from users
       where id = $1
         and deletion_status = 'active'
       for update`,
      [input.userId]
    );
    if (!user.rows[0]) throw new UploadReservationError('UPLOAD_USER_NOT_FOUND');

    if (input.projectSpaceId) {
      const projectSpace = await client.query<{ id: string }>(
        `select id
         from project_spaces
         where id = $1
           and user_id = $2
           and status = 'active'
         for update`,
        [input.projectSpaceId, input.userId]
      );
      if (!projectSpace.rows[0]) {
        throw new UploadReservationError('UPLOAD_PROJECT_NOT_FOUND');
      }
    }

    const claimed = await findClaimedFileWithClient(
      client,
      input.userId,
      input.hash,
      input.projectSpaceId,
      conversionProfile
    );
    if (claimed) {
      const canResumeUpload = !claimed.object_key
        && (claimed.status === 'uploading' || claimed.status === 'failed');
      if (!canResumeUpload) return { file: claimed, created: false };

      const currentReservation = toByteCount(claimed.reserved_bytes);
      const desiredReservation = BigInt(input.size);
      if (desiredReservation > currentReservation) {
        await ensureQuotaAvailable(
          client,
          input.userId,
          Number(desiredReservation - currentReservation),
          limits
        );
      }

      if (claimed.status === 'failed' || desiredReservation !== currentReservation) {
        const { rows } = await client.query<FileRow>(
          `update files
           set status = 'uploading',
               filename = $2,
               file_size = $3,
               file_type = $4,
               declared_mime_type = $5,
               document_kind = $6,
               reserved_bytes = $7,
               storage_bytes = 0,
               progress = 0,
               error_message = null,
               updated_at = now()
           where id = $1
           returning ${columns}`,
          [
            claimed.id,
            input.filename,
            input.size,
            input.type || null,
            input.declaredMimeType || null,
            documentKind,
            input.size,
          ]
        );
        return { file: rows[0], created: false };
      }

      return { file: claimed, created: false };
    }

    await ensureQuotaAvailable(client, input.userId, input.size, limits);

    const inserted = await client.query<FileRow>(
      `insert into files (
         user_id,
         project_space_id,
         filename,
         file_hash,
         file_size,
         file_type,
         declared_mime_type,
         document_kind,
         status,
         max_attempts,
         reserved_bytes,
         storage_bytes
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'uploading', $9, $10, 0)
       returning ${columns}`,
      [
        input.userId,
        input.projectSpaceId || null,
        input.filename,
        input.hash,
        input.size,
        input.type || null,
        input.declaredMimeType || null,
        documentKind,
        serverEnv.FILE_QUEUE_MAX_ATTEMPTS,
        input.size,
      ]
    );
    const file = inserted.rows[0];

    const claim = await client.query<{ file_id: string }>(
      `insert into file_content_claims (
         user_id,
         scope_key,
         file_hash,
         conversion_profile,
         file_id
       )
       values ($1, $2, $3, $4, $5)
       on conflict do nothing
       returning file_id`,
      [
        input.userId,
        getFileContentScopeKey(input.projectSpaceId),
        input.hash,
        conversionProfile,
        file.id,
      ]
    );
    if (claim.rows[0]) return { file, created: true };

    const canonical = await findClaimedFileWithClient(
      client,
      input.userId,
      input.hash,
      input.projectSpaceId,
      conversionProfile
    );
    await client.query('delete from files where id = $1', [file.id]);
    if (!canonical) throw new Error('Canonical upload claim disappeared');
    return { file: canonical, created: false };
  });
};

export const createUploadFile = async (input: UploadReservationInput) => {
  const reservation = await reserveUploadFile(input);
  return reservation.file;
};

export const findFileForUser = async (fileId: string, userId: string) => {
  const { rows } = await query<FileRow>(
    `select ${columns}
     from files
     where id = $1 and user_id = $2`,
    [fileId, userId]
  );
  return rows[0] || null;
};

export interface ActiveConvertedFileContentRow {
  file_id: string;
  filename: string;
  document_kind: DocumentKind;
  conversion_generation_id: string;
  markdown_object_key: string;
  markdown_hash: string;
  markdown_byte_size: number | string;
}

export const findActiveConvertedFileContentForUser = async (
  fileId: string,
  userId: string,
  runQuery: typeof query = query,
) => {
  const { rows } = await runQuery<ActiveConvertedFileContentRow>(
    `select
       target_file.id as file_id,
       target_file.filename,
       target_file.document_kind,
       generation.id as conversion_generation_id,
       generation.markdown_object_key,
       generation.markdown_hash,
       generation.markdown_byte_size
     from files target_file
     join file_conversion_generations generation
       on generation.id = target_file.active_conversion_generation_id
      and generation.file_id = target_file.id
     where target_file.id = $1
       and target_file.user_id = $2
       and target_file.status = 'completed'
       and generation.status in ('completed', 'completed_with_warnings')`,
    [fileId, userId],
  );
  return rows[0] || null;
};

export const listFilesForUser = async (userId: string, projectSpaceId?: string) => {
  const values: unknown[] = [userId];
  let projectSpaceFilter = '';

  if (projectSpaceId) {
    values.push(projectSpaceId);
    projectSpaceFilter = `and project_space_id = $${values.length}`;
  }

  const { rows } = await query<FileRow>(
    `select ${columns}
     from files
     where user_id = $1
       and status <> 'deleting'
       ${projectSpaceFilter}
     order by created_at desc`,
    values
  );
  return rows;
};

const requeueFileCleanupForStoredObject = async (
  client: PoolClient,
  fileId: string,
  objectKey: string
) => {
  const { rows } = await client.query<{ id: string }>(
    `insert into artifact_cleanup_jobs (
       resource_key,
       resource_type,
       resource_id,
       payload
     )
     values (
       'file:' || $1,
       'file',
       $1,
       jsonb_build_object('object_key', $2::text)
     )
     on conflict (resource_key) do update set
       status = 'queued',
       step_state = artifact_cleanup_jobs.step_state - 'storage_deleted' - 'finalized',
       payload = artifact_cleanup_jobs.payload || jsonb_build_object('object_key', $2::text),
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
     returning id`,
    [fileId, objectKey]
  );
  if (!rows[0]) throw new Error('Stored upload cleanup could not be queued');
};

export const updateFile = async (
  fileId: string,
  updates: Partial<Pick<
    FileRow,
    'status' |
    'progress' |
    'error_message' |
    'object_key' |
    'file_type' |
    'attempts' |
    'max_attempts' |
    'next_attempt_at' |
    'last_attempt_at' |
    'reserved_bytes' |
    'storage_bytes'
  >>
) => {
  return withTransaction(async (client) => {
    const { rows: lockedRows } = await client.query<Pick<FileRow, 'status'>>(
      `select status
       from files
       where id = $1
       for update`,
      [fileId]
    );
    const lockedFile = lockedRows[0];
    const objectKey = typeof updates.object_key === 'string' && updates.object_key
      ? updates.object_key
      : null;

    if (!lockedFile || lockedFile.status === 'deleting') {
      if (objectKey) {
        await requeueFileCleanupForStoredObject(client, fileId, objectKey);
      }
      return null;
    }

    const fields: string[] = ['updated_at = now()'];
    const values: unknown[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        values.push(value);
        fields.push(`${key} = $${values.length}`);
      }
    });

    values.push(fileId);
    const { rows } = await client.query<FileRow>(
      `update files
       set ${fields.join(', ')}
       where id = $${values.length}
         and status <> 'deleting'
       returning ${columns}`,
      values
    );

    return rows[0] || null;
  });
};

export const deleteAbandonedUploadingFiles = async (
  maxAgeMs = serverEnv.UPLOAD_TEMP_MAX_AGE_MS,
  limit = 50
) => {
  const { rows } = await query<Pick<FileRow, 'id'>>(
    `with stale_files as (
       select f.id
       from files f
       where f.status = 'uploading'
         and f.object_key is null
         and f.updated_at <= now() - ($1::double precision * interval '1 millisecond')
         and not exists (
           select 1
           from upload_multipart_sessions ums
           where ums.file_id = f.id
         )
       order by f.updated_at asc
       limit $2
     )
     delete from files f
     using stale_files
     where f.id = stale_files.id
     returning f.id`,
    [maxAgeMs, limit]
  );

  return rows.length;
};

export const retryFailedFileForUser = async (fileId: string, userId: string) => {
  const { rows } = await query<FileRow>(
    `update files
     set status = 'pending',
         progress = 0,
         error_message = null,
         attempts = 0,
         max_attempts = $3,
         next_attempt_at = null,
         last_attempt_at = null,
         updated_at = now()
     where id = $1
       and user_id = $2
       and status = 'failed'
       and object_key is not null
     returning ${columns}`,
    [fileId, userId, serverEnv.FILE_QUEUE_MAX_ATTEMPTS]
  );

  return rows[0] || null;
};

export interface FileIngestionClaim {
  file: Pick<FileRow, 'id'> & Partial<FileRow>;
  attemptId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export type FileIngestionReconciliation = {
  state: 'active' | 'completed' | 'failed' | 'superseded';
};

interface ClaimNextPendingFileOptions {
  fileId?: string;
  retryBaseDelayMs?: number;
  staleAfterMs?: number;
  maxAttempts?: number;
  runInTransaction?: typeof withTransaction;
  createId?: () => string;
}

export const claimNextPendingFile = async (options: ClaimNextPendingFileOptions = {}) => {
  const retryBaseDelayMs = options.retryBaseDelayMs ?? serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS;
  const staleAfterMs = options.staleAfterMs ?? serverEnv.FILE_QUEUE_STALE_AFTER_MS;
  const maxAttempts = options.maxAttempts ?? serverEnv.FILE_QUEUE_MAX_ATTEMPTS;
  const runInTransaction = options.runInTransaction || withTransaction;
  const createId = options.createId || randomUUID;

  return runInTransaction(async (client: PoolClient): Promise<FileIngestionClaim | null> => {
    const { rows } = await client.query<FileRow>(
      `select ${columns}
       from files
       where object_key is not null
         and ($3::uuid is null or id = $3::uuid)
         and (
           (
             status = 'pending'
             and (next_attempt_at is null or next_attempt_at <= now())
           )
           or (
             status = 'failed'
             and attempts < greatest(max_attempts, $2)
             and coalesce(
               next_attempt_at,
               updated_at + (
                 least(
                   3600000::double precision,
                   $1::double precision * power(2, greatest(attempts - 1, 0))
                 ) * interval '1 millisecond'
               )
             ) <= now()
           )
           or (
             status = 'processing'
             and attempts < greatest(max_attempts, $2)
             and (
               not exists (
                 select 1
                 from file_ingestion_jobs job
                 where job.file_id = files.id
               )
               or exists (
                 select 1
                 from file_ingestion_jobs job
                 where job.file_id = files.id
                   and job.status in ('queued', 'processing')
                   and job.lease_expires_at <= now()
               )
             )
           )
         )
       order by created_at asc
       limit 1
       for update skip locked`,
      [retryBaseDelayMs, maxAttempts, options.fileId || null]
    );

    const candidate = rows[0];
    if (!candidate) return null;

    const updated = await client.query<FileRow>(
      `update files
       set status = 'processing',
           progress = 0,
           attempts = least(greatest(max_attempts, $2), attempts + 1),
           max_attempts = greatest(max_attempts, $2),
           next_attempt_at = null,
           last_attempt_at = now(),
           error_message = null,
           updated_at = now()
       where id = $1
       returning ${columns}`,
      [candidate.id, maxAttempts]
    );
    const file = updated.rows[0];
    if (!file) return null;

    const attemptId = createId();
    const leaseToken = createId();
    const job = await client.query<{ lease_expires_at: string | Date }>(
      `insert into file_ingestion_jobs (
         file_id,
         user_id,
         project_space_id,
         status,
         stage,
         progress,
         total_chunks,
         indexed_chunks,
         keyword_batches,
         graph_batches,
         vector_batches,
         checkpoint,
         error_message,
         conversion_generation_id,
         started_at,
         completed_at,
         heartbeat_at,
         attempt_id,
         lease_token,
         lease_expires_at
       )
       values (
         $1, $2, $3, 'processing', 'claimed', 0, 0, 0, 0, 0, 0,
         '{}'::jsonb, null, null, now(), null, now(), $4, $5,
         now() + ($6::double precision * interval '1 millisecond')
       )
       on conflict (file_id) do update set
         user_id = excluded.user_id,
         project_space_id = excluded.project_space_id,
         status = 'processing',
         stage = 'claimed',
         progress = 0,
         total_chunks = 0,
         indexed_chunks = 0,
         keyword_batches = 0,
         graph_batches = 0,
         vector_batches = 0,
         checkpoint = '{}'::jsonb,
         error_message = null,
         conversion_generation_id = null,
         started_at = now(),
         completed_at = null,
         heartbeat_at = now(),
         attempt_id = excluded.attempt_id,
         lease_token = excluded.lease_token,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = now()
       returning lease_expires_at`,
      [file.id, file.user_id, file.project_space_id || null, attemptId, leaseToken, staleAfterMs]
    );
    const leaseExpiresAt = job.rows[0]?.lease_expires_at;
    if (!leaseExpiresAt) throw new Error('Ingestion lease creation did not return an expiry');

    return {
      file,
      attemptId,
      leaseToken,
      leaseExpiresAt: leaseExpiresAt instanceof Date
        ? leaseExpiresAt.toISOString()
        : String(leaseExpiresAt),
    };
  });
};

export interface MarkdownReingestionOptions {
  limit?: number;
  projectSpaceId?: string | null;
}

const markdownReingestionPredicate = `
  files.object_key is not null
  and files.status in ('completed', 'failed')
  and (
    lower(files.filename) like '%.md'
    or lower(files.filename) like '%.markdown'
  )
  and ($1::uuid is null or files.project_space_id = $1::uuid)
  and not exists (
    select 1
    from file_ingestion_jobs active_job
    where active_job.file_id = files.id
      and active_job.status in ('queued', 'processing')
      and active_job.lease_expires_at > now()
  )
`;

export const countMarkdownFilesForReingestion = async (
  projectSpaceId?: string | null,
  runQuery: typeof query = query,
) => {
  const { rows } = await runQuery<{ count: number | string }>(
    `select count(*)::bigint as count
     from files
     where ${markdownReingestionPredicate}`,
    [projectSpaceId || null],
  );
  return Number(rows[0]?.count || 0);
};

export const queueMarkdownFilesForReingestion = async (options: MarkdownReingestionOptions = {}) => {
  const boundedLimit = Number.isSafeInteger(options.limit)
    ? Math.min(Math.max(Number(options.limit), 1), 1000)
    : 100;

  return withTransaction(async (client) => {
    const { rows } = await client.query<FileRow>(
       `with candidates as (
         select files.id
         from files
         where ${markdownReingestionPredicate}
         order by files.updated_at asc, files.id asc
         for update skip locked
         limit $2
       )
       update files
       set status = 'pending',
           progress = 0,
           error_message = null,
           attempts = 0,
           max_attempts = $3,
           next_attempt_at = null,
           last_attempt_at = null,
           updated_at = now()
       from candidates
       where files.id = candidates.id
       returning files.*`,
      [
        options.projectSpaceId || null,
        boundedLimit,
        serverEnv.FILE_QUEUE_MAX_ATTEMPTS,
      ],
    );
    return rows;
  });
};

export const claimPendingFileById = async (
  fileId: string,
  options: Omit<ClaimNextPendingFileOptions, 'fileId'> = {}
) => claimNextPendingFile({ ...options, fileId });

export const listDispatchableFileIds = async (
  limit = 50,
  runQuery: typeof query = query
) => {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const { rows } = await runQuery<{ id: string }>(
    `select id
     from files
     where object_key is not null
       and (
         (
           status = 'pending'
           and (next_attempt_at is null or next_attempt_at <= now())
         )
         or (
           status = 'failed'
           and attempts < greatest(max_attempts, $2)
           and coalesce(
             next_attempt_at,
             updated_at + (
               least(
                 3600000::double precision,
                 $1::double precision * power(2, greatest(attempts - 1, 0))
               ) * interval '1 millisecond'
             )
           ) <= now()
         )
         or (
           status = 'processing'
           and attempts < greatest(max_attempts, $2)
           and (
             not exists (
               select 1 from file_ingestion_jobs job where job.file_id = files.id
             )
             or exists (
               select 1
               from file_ingestion_jobs job
               where job.file_id = files.id
                 and job.status in ('queued', 'processing')
                 and job.lease_expires_at <= now()
             )
           )
         )
       )
     order by created_at asc
     limit $3`,
    [serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS, serverEnv.FILE_QUEUE_MAX_ATTEMPTS, boundedLimit]
  );
  return rows.map((row) => row.id);
};

interface RenewFileIngestionLeaseOptions {
  leaseDurationMs?: number;
  runQuery?: typeof query;
}

export const renewFileIngestionLease = async (
  claim: Pick<FileIngestionClaim, 'file' | 'attemptId' | 'leaseToken'>,
  options: RenewFileIngestionLeaseOptions = {}
) => {
  const leaseDurationMs = options.leaseDurationMs ?? serverEnv.FILE_QUEUE_STALE_AFTER_MS;
  const runQuery = options.runQuery || query;
  const { rows } = await runQuery<{ lease_expires_at: string | Date }>(
    `update file_ingestion_jobs
     set lease_expires_at = now() + ($4::double precision * interval '1 millisecond'),
         heartbeat_at = now(),
         updated_at = now()
     where file_id = $1
       and attempt_id = $2
       and lease_token = $3
       and status = 'processing'
       and lease_expires_at > now()
     returning lease_expires_at`,
    [claim.file.id, claim.attemptId, claim.leaseToken, leaseDurationMs]
  );
  const leaseExpiresAt = rows[0]?.lease_expires_at;
  if (!leaseExpiresAt) return null;
  return leaseExpiresAt instanceof Date ? leaseExpiresAt.toISOString() : String(leaseExpiresAt);
};

interface MarkFileIngestionAttemptUnavailableOptions {
  runQuery?: typeof query;
}

export const markFileIngestionAttemptUnavailable = async (
  claim: Pick<FileIngestionClaim, 'file' | 'attemptId' | 'leaseToken'>,
  options: MarkFileIngestionAttemptUnavailableOptions = {}
) => {
  const runQuery = options.runQuery || query;
  const { rows } = await runQuery<{ file_id: string }>(
    `update file_ingestion_jobs
     set status = 'failed',
         stage = 'failed',
         error_message = 'RAG service is temporarily unavailable',
         lease_expires_at = now(),
         heartbeat_at = now(),
         updated_at = now()
     where file_id = $1
       and attempt_id = $2
       and lease_token = $3
       and status in ('queued', 'processing')
       and lease_expires_at > now()
     returning file_id`,
    [claim.file.id, claim.attemptId, claim.leaseToken]
  );
  return rows.length > 0;
};

interface FileIngestionJobRow {
  file_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempt_id: string;
  lease_token: string;
  lease_expires_at?: string | Date;
  lease_active: boolean;
  error_message?: string | null;
}

interface ReconcileFileIngestionAttemptOptions {
  runInTransaction?: typeof withTransaction;
  retryBaseDelayMs?: number;
  maxAttempts?: number;
}

const getIngestionFailureMessage = (job: FileIngestionJobRow) => {
  if (job.status === 'cancelled') return 'RAG service ingestion was cancelled';
  if (job.status === 'failed' && job.error_message) return job.error_message.slice(0, 500);
  return 'RAG service ingestion lease expired';
};

export const reconcileFileIngestionAttempt = async (
  claim: Pick<FileIngestionClaim, 'file' | 'attemptId' | 'leaseToken'>,
  options: ReconcileFileIngestionAttemptOptions = {}
): Promise<FileIngestionReconciliation> => {
  const runInTransaction = options.runInTransaction || withTransaction;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? serverEnv.FILE_QUEUE_MAX_ATTEMPTS;

  return runInTransaction(async (client) => {
    const fileResult = await client.query<FileRow>(
      `select ${columns}
       from files
       where id = $1
       for update`,
      [claim.file.id]
    );
    const file = fileResult.rows[0];
    if (!file) return { state: 'superseded' };
    if (file.status === 'completed') return { state: 'completed' };
    if (file.status !== 'processing') return { state: 'superseded' };

    const jobResult = await client.query<FileIngestionJobRow>(
      `select
         file_id,
         status,
         attempt_id,
         lease_token,
         lease_expires_at,
         lease_expires_at > now() as lease_active,
         error_message
       from file_ingestion_jobs
       where file_id = $1
       for update`,
      [claim.file.id]
    );
    const job = jobResult.rows[0];
    if (!job) return { state: 'superseded' };
    if (job.attempt_id !== claim.attemptId || job.lease_token !== claim.leaseToken) {
      return { state: 'superseded' };
    }

    if (job.status === 'completed') {
      await client.query(
        `update files
         set status = 'completed',
             progress = 100,
             error_message = null,
             next_attempt_at = null,
             updated_at = now()
         where id = $1
           and status = 'processing'`,
        [file.id]
      );
      return { state: 'completed' };
    }

    if ((job.status === 'queued' || job.status === 'processing') && job.lease_active) {
      return { state: 'active' };
    }

    const errorMessage = getIngestionFailureMessage(job);
    await client.query(
      `update files
       set status = 'failed',
           progress = 0,
           error_message = case
             when attempts >= greatest(max_attempts, $3)
               then 'Max attempts reached after ' || attempts::text || ' attempts: ' || $2
             else $2
           end,
           max_attempts = greatest(max_attempts, $3),
           next_attempt_at = case
             when attempts >= greatest(max_attempts, $3) then null
             else now() + (
               least(
                 3600000::double precision,
                 $4::double precision * power(2, greatest(attempts - 1, 0))
               ) * interval '1 millisecond'
             )
           end,
           updated_at = now()
       where id = $1
         and status = 'processing'`,
      [file.id, errorMessage, maxAttempts, retryBaseDelayMs]
    );
    return { state: 'failed' };
  });
};

interface ReconcileFileIngestionJobsOptions extends ReconcileFileIngestionAttemptOptions {
  limit?: number;
  runQuery?: typeof query;
  reconcileAttempt?: typeof reconcileFileIngestionAttempt;
}

export const reconcileFileIngestionJobs = async (
  options: ReconcileFileIngestionJobsOptions = {}
) => {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const runQuery = options.runQuery || query;
  const reconcileAttempt = options.reconcileAttempt || reconcileFileIngestionAttempt;
  const { rows } = await runQuery<{
    file_id: string;
    attempt_id: string;
    lease_token: string;
  }>(
    `select job.file_id, job.attempt_id, job.lease_token
     from file_ingestion_jobs job
     join files file on file.id = job.file_id
     where file.status = 'processing'
       and (
         job.status in ('completed', 'failed', 'cancelled')
         or (
           job.status in ('queued', 'processing')
           and job.lease_expires_at <= now()
         )
       )
     order by job.updated_at asc
     limit $1`,
    [limit]
  );

  const results: FileIngestionReconciliation[] = [];
  for (const row of rows) {
    results.push(await reconcileAttempt({
      file: { id: row.file_id },
      attemptId: row.attempt_id,
      leaseToken: row.lease_token,
    }, options));
  }
  return results;
};

export const listFilesForUserCleanup = async (userId: string) => {
  const { rows } = await query<Pick<FileRow, 'id' | 'object_key'>>(
    `select id, object_key
     from files
     where user_id = $1`,
    [userId]
  );
  return rows;
};
