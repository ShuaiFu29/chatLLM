import { query } from '../lib/db';

export type MultipartUploadSessionStatus =
  | 'initiated'
  | 'uploading'
  | 'completing'
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

export const createMultipartUploadSession = async (input: {
  fileId: string;
  userId: string;
  projectSpaceId?: string | null;
  objectKey: string;
  storageUploadId: string;
  partSize: number;
  totalParts: number;
  expiresAt: Date;
}) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `insert into upload_multipart_sessions (
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
     returning ${columns}`,
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

  return rows[0];
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
       and status in ('initiated', 'uploading', 'completing')
       and expires_at > now()`,
    [fileId, userId]
  );

  return rows[0] || null;
};

export const markMultipartUploadSessionUploading = async (fileId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'uploading',
         error_message = null,
         updated_at = now()
     where file_id = $1
       and status in ('initiated', 'uploading')
     returning ${columns}`,
    [fileId]
  );

  return rows[0] || null;
};

export const markMultipartUploadSessionCompleting = async (fileId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'completing',
         error_message = null,
         updated_at = now()
     where file_id = $1
       and status in ('initiated', 'uploading', 'completing')
     returning ${columns}`,
    [fileId]
  );

  return rows[0] || null;
};

export const markMultipartUploadSessionCompleted = async (fileId: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'completed',
         completed_at = now(),
         error_message = null,
         updated_at = now()
     where file_id = $1
     returning ${columns}`,
    [fileId]
  );

  return rows[0] || null;
};

export const markMultipartUploadSessionFailed = async (fileId: string, errorMessage: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'failed',
         error_message = $2,
         updated_at = now()
     where file_id = $1
     returning ${columns}`,
    [fileId, errorMessage]
  );

  return rows[0] || null;
};

export const markMultipartUploadSessionCancelled = async (fileId: string, errorMessage?: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'cancelled',
         error_message = $2,
         updated_at = now()
     where file_id = $1
     returning ${columns}`,
    [fileId, errorMessage || null]
  );

  return rows[0] || null;
};

export const listExpiredMultipartUploadSessions = async (limit = 20) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `select ${columns}
     from upload_multipart_sessions
     where status in ('initiated', 'uploading', 'completing')
       and expires_at <= now()
     order by expires_at asc
     limit $1`,
    [limit]
  );

  return rows;
};

export const markMultipartUploadSessionExpired = async (fileId: string, errorMessage: string) => {
  const { rows } = await query<MultipartUploadSessionRow>(
    `update upload_multipart_sessions
     set status = 'expired',
         error_message = $2,
         updated_at = now()
     where file_id = $1
     returning ${columns}`,
    [fileId, errorMessage]
  );

  return rows[0] || null;
};
