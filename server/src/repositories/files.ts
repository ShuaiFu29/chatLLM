import { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';

export interface FileRow {
  id: string;
  user_id: string;
  filename: string;
  file_hash: string;
  file_size?: number | null;
  file_type?: string | null;
  object_key?: string | null;
  status: 'uploading' | 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

const columns = `
  id,
  user_id,
  filename,
  file_hash,
  file_size,
  file_type,
  object_key,
  status,
  progress,
  error_message,
  created_at,
  updated_at
`;

export const findCompletedFileByUserAndHash = async (userId: string, hash: string) => {
  const { rows } = await query<FileRow>(
    `select ${columns}
     from files
     where user_id = $1 and file_hash = $2 and status = 'completed'
     order by created_at desc
     limit 1`,
    [userId, hash]
  );
  return rows[0] || null;
};

export const findUploadingFileByUserAndHash = async (userId: string, hash: string) => {
  const { rows } = await query<Pick<FileRow, 'id'>>(
    `select id
     from files
     where user_id = $1 and file_hash = $2 and status = 'uploading'
     order by created_at desc
     limit 1`,
    [userId, hash]
  );
  return rows[0] || null;
};

export const createUploadFile = async (input: {
  userId: string;
  filename: string;
  hash: string;
  size?: number;
  type?: string;
}) => {
  const { rows } = await query<FileRow>(
    `insert into files (user_id, filename, file_hash, file_size, file_type, status)
     values ($1, $2, $3, $4, $5, 'uploading')
     returning ${columns}`,
    [input.userId, input.filename, input.hash, input.size || null, input.type || null]
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

export const listFilesForUser = async (userId: string) => {
  const { rows } = await query<FileRow>(
    `select ${columns}
     from files
     where user_id = $1
     order by created_at desc`,
    [userId]
  );
  return rows;
};

export const updateFile = async (
  fileId: string,
  updates: Partial<Pick<FileRow, 'status' | 'progress' | 'error_message' | 'object_key' | 'file_type'>>
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

export const claimNextPendingFile = async () => {
  return withTransaction(async (client: PoolClient) => {
    const { rows } = await client.query<FileRow>(
      `with next_file as (
         select id
         from files
         where status = 'pending'
         order by created_at asc
         limit 1
         for update skip locked
       )
       update files
       set status = 'processing', updated_at = now()
       where id in (select id from next_file)
       returning ${columns}`
    );

    return rows[0] || null;
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
