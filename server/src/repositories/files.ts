import { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';

export interface FileRow {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  filename: string;
  file_hash: string;
  file_size?: number | null;
  file_type?: string | null;
  object_key?: string | null;
  status: 'uploading' | 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  error_message?: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_attempt_at?: string | null;
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
  object_key,
  status,
  progress,
  error_message,
  attempts,
  max_attempts,
  next_attempt_at,
  last_attempt_at,
  created_at,
  updated_at
`;

export const findCompletedFileByUserAndHash = async (userId: string, hash: string, projectSpaceId?: string | null) => {
  const values: unknown[] = [userId, hash];
  let projectSpaceFilter = '';

  if (projectSpaceId) {
    values.push(projectSpaceId);
    projectSpaceFilter = `and project_space_id = $${values.length}`;
  }

  const { rows } = await query<FileRow>(
    `select ${columns}
     from files
     where user_id = $1 and file_hash = $2 and status = 'completed'
       ${projectSpaceFilter}
     order by created_at desc
     limit 1`,
    values
  );
  return rows[0] || null;
};

export const findUploadingFileByUserAndHash = async (userId: string, hash: string, projectSpaceId?: string | null) => {
  const values: unknown[] = [userId, hash];
  let projectSpaceFilter = '';

  if (projectSpaceId) {
    values.push(projectSpaceId);
    projectSpaceFilter = `and project_space_id = $${values.length}`;
  }

  const { rows } = await query<Pick<FileRow, 'id'>>(
    `select id
     from files
     where user_id = $1 and file_hash = $2 and status = 'uploading'
       ${projectSpaceFilter}
     order by created_at desc
     limit 1`,
    values
  );
  return rows[0] || null;
};

export const createUploadFile = async (input: {
  userId: string;
  filename: string;
  hash: string;
  size?: number;
  type?: string;
  projectSpaceId?: string | null;
}) => {
  const { rows } = await query<FileRow>(
    `insert into files (user_id, project_space_id, filename, file_hash, file_size, file_type, status, max_attempts)
     values ($1, $2, $3, $4, $5, $6, 'uploading', $7)
     returning ${columns}`,
    [
      input.userId,
      input.projectSpaceId || null,
      input.filename,
      input.hash,
      input.size || null,
      input.type || null,
      serverEnv.FILE_QUEUE_MAX_ATTEMPTS,
    ]
  );
  return rows[0];
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
       ${projectSpaceFilter}
     order by created_at desc`,
    values
  );
  return rows;
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
    'last_attempt_at'
  >>
) => {
  const fields: string[] = ['updated_at = now()'];
  const values: unknown[] = [];

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      values.push(value);
      fields.push(`${key} = $${values.length}`);
    }
  });

  values.push(fileId);
  const { rows } = await query<FileRow>(
    `update files
     set ${fields.join(', ')}
     where id = $${values.length}
     returning ${columns}`,
    values
  );

  return rows[0] || null;
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

export const deleteFileForUser = async (fileId: string, userId: string) => {
  return withTransaction(async (client) => {
    const { rows } = await client.query<FileRow>(
      `select ${columns}
       from files
       where id = $1 and user_id = $2
       for update`,
      [fileId, userId]
    );

    const file = rows[0];
    if (!file) return null;

    await client.query('delete from files where id = $1 and user_id = $2', [fileId, userId]);
    return file;
  });
};

interface ClaimNextPendingFileOptions {
  retryBaseDelayMs?: number;
  staleAfterMs?: number;
  maxAttempts?: number;
}

export const claimNextPendingFile = async (options: ClaimNextPendingFileOptions = {}) => {
  const retryBaseDelayMs = options.retryBaseDelayMs ?? serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS;
  const staleAfterMs = options.staleAfterMs ?? serverEnv.FILE_QUEUE_STALE_AFTER_MS;
  const maxAttempts = options.maxAttempts ?? serverEnv.FILE_QUEUE_MAX_ATTEMPTS;

  return withTransaction(async (client: PoolClient) => {
    const { rows } = await client.query<FileRow>(
      `with next_file as (
         select id
         from files
         where (
           status = 'pending'
           and (next_attempt_at is null or next_attempt_at <= now())
         )
         or (
           status = 'failed'
           and attempts < greatest(max_attempts, $3)
           and coalesce(
             next_attempt_at,
             updated_at + (least(3600000::double precision, $1::double precision * power(2, greatest(attempts - 1, 0))) * interval '1 millisecond')
           ) <= now()
         )
         or (
           status = 'processing'
           and last_attempt_at is not null
           and last_attempt_at <= now() - ($2::double precision * interval '1 millisecond')
           and attempts < greatest(max_attempts, $3)
         )
         order by created_at asc
         limit 1
         for update skip locked
       )
       update files
       set status = 'processing',
           progress = 0,
           attempts = least(greatest(max_attempts, $3), attempts + 1),
           max_attempts = greatest(max_attempts, $3),
           next_attempt_at = null,
           last_attempt_at = now(),
           error_message = null,
           updated_at = now()
       where id in (select id from next_file)
       returning ${columns}`,
      [retryBaseDelayMs, staleAfterMs, maxAttempts]
    );

    return rows[0] || null;
  });
};

export const markFileAttemptFailed = async (file: Pick<FileRow, 'id' | 'attempts' | 'max_attempts'>, errorMessage: string) => {
  const maxAttempts = Math.max(file.max_attempts || 0, serverEnv.FILE_QUEUE_MAX_ATTEMPTS);
  const attempts = file.attempts || 1;
  const exhausted = attempts >= maxAttempts;
  const retryDelayMs = Math.min(
    60 * 60 * 1000,
    serverEnv.FILE_QUEUE_RETRY_BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0)
  );

  return updateFile(file.id, {
    status: 'failed',
    progress: 0,
    error_message: exhausted
      ? `Max attempts reached after ${attempts} attempts: ${errorMessage}`
      : errorMessage,
    max_attempts: maxAttempts,
    next_attempt_at: exhausted ? null : new Date(Date.now() + retryDelayMs).toISOString(),
  });
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
