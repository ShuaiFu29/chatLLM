import { query, withTransaction } from '../lib/db';

export type MultipartUploadSessionStatus =
  | 'initiated'
  | 'uploading'
  | 'completing'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface MultipartUploadSessionRow {
  file_id: string;
  user_id: string;
  project_space_id?: string | null;
  object_key: string;
  storage_upload_id: string;
  part_size: number;
  total_parts: number;
  status: MultipartUploadSessionStatus;
  expires_at: string;
  completed_at?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

const columns = `
  file_id,
  user_id,
  project_space_id,
  object_key,
  storage_upload_id,
  part_size,
  total_parts,
  status,
  expires_at,
  completed_at,
  error_message,
  created_at,
  updated_at
`;

export const MULTIPART_UPLOAD_UNAVAILABLE = 'MULTIPART_UPLOAD_UNAVAILABLE';

interface CreateMultipartUploadSessionOptions {
  runInTransaction?: typeof withTransaction;
}

export const createMultipartUploadSession = async (
  input: {
    fileId: string;
    userId: string;
    projectSpaceId?: string | null;
    objectKey: string;
    storageUploadId: string;
    partSize: number;
    totalParts: number;
    expiresAt: Date;
  },
  options: CreateMultipartUploadSessionOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  return runInTransaction(async (client) => {
    const file = await client.query<{ id: string }>(
      `select id
       from files
       where id = $1
         and user_id = $2
         and status = 'uploading'
       for update`,
      [input.fileId, input.userId]
    );
    if (!file.rows[0]) {
      throw Object.assign(new Error('Multipart upload file is unavailable'), {
        code: MULTIPART_UPLOAD_UNAVAILABLE,
      });
    }

    const { rows } = await client.query<MultipartUploadSessionRow & { created: boolean }>(
      `with accepted as (
         insert into upload_multipart_sessions (
           file_id,
           user_id,
           project_space_id,
           object_key,
           storage_upload_id,
           part_size,
           total_parts,
           expires_at
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (file_id) do update
           set storage_upload_id = excluded.storage_upload_id,
               object_key = excluded.object_key,
               part_size = excluded.part_size,
               total_parts = excluded.total_parts,
               status = 'initiated',
               expires_at = excluded.expires_at,
               completed_at = null,
               error_message = null,
               updated_at = now()
           where upload_multipart_sessions.status in ('failed', 'cancelled', 'expired')
         returning true as created, ${columns}
       )
       select created, ${columns}
       from accepted
       union all
       select false as created, ${columns}
       from upload_multipart_sessions
       where file_id = $1
         and user_id = $2
         and not exists (select 1 from accepted)
       limit 1`,
      [
        input.fileId,
        input.userId,
        input.projectSpaceId || null,
        input.objectKey,
        input.storageUploadId,
        input.partSize,
        input.totalParts,
        input.expiresAt.toISOString(),
      ]
    );

    let row = rows[0];
    if (!row) {
      const existing = await client.query<MultipartUploadSessionRow & { created: boolean }>(
        `select false as created, ${columns}
         from upload_multipart_sessions
         where file_id = $1 and user_id = $2`,
        [input.fileId, input.userId]
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error('Multipart upload session conflict could not be resolved');
    const { created, ...session } = row;
    return { created, session };
  });
};

export const findMultipartUploadSessionForUser = async (fileId: string, userId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `select ${columns}
     from upload_multipart_sessions
     where file_id = $1 and user_id = $2`,
    [fileId, userId]
  );

  return rows[0] || null;
};

export const findActiveMultipartUploadSession = async (fileId: string, userId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `select ${columns}
     from upload_multipart_sessions
     where file_id = $1
       and user_id = $2
       and status in ('initiated', 'uploading', 'completing', 'cancelling')`,
    [fileId, userId]
  );

  return rows[0] || null;
};

export const markMultipartUploadSessionUploading = async (fileId: string, userId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'uploading',
         error_message = null,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status in ('initiated', 'uploading')
     returning ${columns}`,
    [fileId, userId]
  );

  return rows[0] || null;
};

export const claimMultipartUploadCompletion = async (fileId: string, userId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'completing',
         error_message = null,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status in ('initiated', 'uploading')
     returning ${columns}`,
    [fileId, userId]
  );

  return rows[0] || null;
};

export const claimMultipartUploadAbort = async (fileId: string, userId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'cancelling',
         error_message = null,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status in ('initiated', 'uploading')
     returning ${columns}`,
    [fileId, userId]
  );

  return rows[0] || null;
};

export const releaseMultipartUploadCompletion = async (
  fileId: string,
  userId: string,
  errorMessage: string
) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'uploading',
         error_message = $3,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status = 'completing'
     returning ${columns}`,
    [fileId, userId, errorMessage]
  );

  return rows[0] || null;
};

export const markMultipartUploadCompletionRetryable = async (
  fileId: string,
  userId: string,
  errorMessage: string
) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set error_message = $3,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status = 'completing'
     returning ${columns}`,
    [fileId, userId, errorMessage]
  );

  return rows[0] || null;
};

export const reclaimMultipartUploadCompletion = async (
  fileId: string,
  userId: string,
  expectedErrorMessage: string
) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set error_message = null,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status = 'completing'
       and error_message = $3
     returning ${columns}`,
    [fileId, userId, expectedErrorMessage]
  );

  return rows[0] || null;
};

export const markMultipartUploadAbortRetryable = async (
  fileId: string,
  userId: string,
  errorMessage: string
) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set error_message = $3,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status = 'cancelling'
     returning ${columns}`,
    [fileId, userId, errorMessage]
  );

  return rows[0] || null;
};

export const finalizeMultipartUploadCompletion = async (
  fileId: string,
  userId: string,
  objectKey: string,
  storageBytes: number
) => withTransaction(async (client) => {
  if (!Number.isSafeInteger(storageBytes) || storageBytes < 0) {
    throw new Error('Invalid multipart storage byte count');
  }

  const { rows: fileRows } = await client.query<{
    id: string;
    status: string;
    object_key: string | null;
    file_size: number | string | null;
    storage_bytes: number | string;
  }>(
    `select id, status, object_key, file_size, storage_bytes
     from files
     where id = $1 and user_id = $2
     for update`,
    [fileId, userId]
  );
  const file = fileRows[0];
  if (!file) return { transitioned: false, session: null };

  const { rows: sessionRows } = await client.query<MultipartUploadSessionRow>(
    `select ${columns}
     from upload_multipart_sessions
     where file_id = $1 and user_id = $2
     for update`,
    [fileId, userId]
  );
  const session = sessionRows[0];
  if (!session) return { transitioned: false, session: null };
  if (session.status === 'completed') {
    return { transitioned: false, session };
  }
  if (!['completing', 'cancelling'].includes(session.status)) {
    return { transitioned: false, session };
  }
  if (session.object_key !== objectKey || Number(file.file_size) !== storageBytes) {
    throw new Error('Invalid multipart completion evidence');
  }
  if (file.status !== 'uploading' && !(file.status === 'pending' && file.object_key === objectKey)) {
    return { transitioned: false, session };
  }
  if (file.status === 'pending' && Number(file.storage_bytes) !== storageBytes) {
    throw new Error('Invalid multipart completion evidence');
  }

  if (file.status === 'uploading') {
    await client.query(
      `update files
       set status = 'pending',
           object_key = $3,
           progress = 0,
           error_message = null,
           reserved_bytes = 0,
           storage_bytes = $4,
           updated_at = now()
       where id = $1 and user_id = $2 and status = 'uploading'`,
      [fileId, userId, objectKey, storageBytes]
    );
  }

  const { rows } = await client.query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'completed',
         completed_at = now(),
         error_message = null,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status in ('completing', 'cancelling')
     returning ${columns}`,
    [fileId, userId]
  );

  return { transitioned: Boolean(rows[0]), session: rows[0] || session };
});

export const finalizeMultipartUploadAbort = async (
  fileId: string,
  userId: string,
  errorMessage: string,
  terminalStatus: 'cancelled' | 'expired' = 'cancelled'
) => withTransaction(async (client) => {
  const { rows: fileRows } = await client.query<{ id: string; status: string }>(
    `select id, status
     from files
     where id = $1 and user_id = $2
     for update`,
    [fileId, userId]
  );
  const file = fileRows[0];
  if (!file) return { transitioned: false, session: null };

  const { rows: sessionRows } = await client.query<MultipartUploadSessionRow>(
    `select ${columns}
     from upload_multipart_sessions
     where file_id = $1 and user_id = $2
     for update`,
    [fileId, userId]
  );
  const session = sessionRows[0];
  if (!session) return { transitioned: false, session: null };
  if (session.status === 'cancelled' || session.status === 'expired') {
    return { transitioned: false, session };
  }
  if (session.status !== 'cancelling' || file.status !== 'uploading') {
    return { transitioned: false, session };
  }

  await client.query(
    `update files
     set status = 'failed',
         object_key = null,
         progress = 0,
         error_message = $3,
         reserved_bytes = 0,
         storage_bytes = 0,
         updated_at = now()
     where id = $1 and user_id = $2 and status = 'uploading'`,
    [fileId, userId, errorMessage]
  );

  const { rows } = await client.query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = $4,
         error_message = $3,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status = 'cancelling'
     returning ${columns}`,
    [fileId, userId, errorMessage, terminalStatus]
  );

  return { transitioned: Boolean(rows[0]), session: rows[0] || session };
});

export const finalizeMultipartUploadFailure = async (
  fileId: string,
  userId: string,
  errorMessage: string
) => withTransaction(async (client) => {
  const { rows: fileRows } = await client.query<{ id: string; status: string }>(
    `select id, status
     from files
     where id = $1 and user_id = $2
     for update`,
    [fileId, userId]
  );
  const file = fileRows[0];
  if (!file) return { transitioned: false, session: null };

  const { rows: sessionRows } = await client.query<MultipartUploadSessionRow>(
    `select ${columns}
     from upload_multipart_sessions
     where file_id = $1 and user_id = $2
     for update`,
    [fileId, userId]
  );
  const session = sessionRows[0];
  if (!session) return { transitioned: false, session: null };
  if (session.status === 'failed') return { transitioned: false, session };
  if (session.status !== 'completing' || file.status !== 'uploading') {
    return { transitioned: false, session };
  }

  await client.query(
    `update files
     set status = 'failed',
         object_key = null,
         progress = 0,
         error_message = $3,
         reserved_bytes = 0,
         storage_bytes = 0,
         updated_at = now()
     where id = $1 and user_id = $2 and status = 'uploading'`,
    [fileId, userId, errorMessage]
  );

  const { rows } = await client.query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'failed',
         error_message = $3,
         updated_at = now()
     where file_id = $1
       and user_id = $2
       and status = 'completing'
     returning ${columns}`,
    [fileId, userId, errorMessage]
  );

  return { transitioned: Boolean(rows[0]), session: rows[0] || session };
});

export const listExpiredMultipartUploadSessions = async (limit = 20) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `select ${columns}
     from upload_multipart_sessions
     where status in ('initiated', 'uploading', 'cancelling')
       and expires_at <= now()
     order by expires_at asc
     limit $1`,
    [limit]
  );

  return rows;
};
