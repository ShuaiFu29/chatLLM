import { query, withTransaction } from '../lib/db';
import { normalizeGithubId, normalizeNullableGithubId } from '../lib/githubId';
import { User } from '../types';
import { enqueueAvatarCleanupWithClient } from './cleanupJobs';

export interface DbUser extends User {
  avatar_object_key?: string | null;
  deletion_status: 'active' | 'pending';
}

interface DbUserRow extends Omit<DbUser, 'github_id'> {
  github_id: string | null;
}

export interface LocalUserCredentials {
  user: DbUser;
  passwordHash: string;
}

interface LocalUserCredentialsRow extends DbUserRow {
  password_hash: string;
}

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('Email is already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

const userColumns = `
  id,
  github_id,
  username,
  avatar_url,
  avatar_object_key,
  display_name,
  settings,
  deletion_status,
  created_at
`;

const toDbUser = (row: DbUserRow): DbUser => {
  return {
    ...row,
    github_id: normalizeNullableGithubId(row.github_id),
  };
};

export const findUserByGithubId = async (githubId: string) => {
  const normalizedGithubId = normalizeGithubId(githubId);
  const { rows } = await query<DbUserRow>(
    `select ${userColumns} from users where github_id = $1`,
    [normalizedGithubId]
  );
  return rows[0] ? toDbUser(rows[0]) : null;
};

export const findUserById = async (id: string) => {
  const { rows } = await query<DbUserRow>(
    `select ${userColumns} from users where id = $1`,
    [id]
  );
  return rows[0] ? toDbUser(rows[0]) : null;
};

export const findUserCredentialsByEmail = async (email: string) => {
  const { rows } = await query<LocalUserCredentialsRow>(
    `select ${userColumns}, password_hash
     from users
     where email = $1
       and password_hash is not null`,
    [email]
  );
  const row = rows[0];
  if (!row) return null;
  const { password_hash: passwordHash, ...user } = row;
  return { user: toDbUser(user), passwordHash };
};

export const createUser = async (input: {
  github_id: string;
  username: string;
  avatar_url: string;
  display_name?: string | null;
}) => {
  const githubId = normalizeGithubId(input.github_id);
  const { rows } = await query<DbUserRow>(
    `insert into users (github_id, username, avatar_url, display_name)
     values ($1, $2, $3, $4)
     returning ${userColumns}`,
    [githubId, input.username, input.avatar_url, input.display_name || input.username]
  );
  return toDbUser(rows[0]);
};

export const createLocalUser = async (input: {
  email: string;
  passwordHash: string;
  displayName: string;
}) => {
  try {
    const { rows } = await query<DbUserRow>(
      `insert into users (
         email,
         password_hash,
         username,
         avatar_url,
         display_name
       )
       values ($1, $2, $3, '', $3)
       returning ${userColumns}`,
      [input.email, input.passwordHash, input.displayName]
    );
    return toDbUser(rows[0]);
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (
      databaseError.code === '23505'
      && databaseError.constraint === 'users_email_unique_idx'
    ) {
      throw new EmailAlreadyRegisteredError();
    }
    throw error;
  }
};

export const updateUser = async (
  id: string,
  updates: {
    display_name?: string;
    avatar_url?: string;
    avatar_object_key?: string | null;
    settings?: Record<string, unknown>;
  }
) => {
  const fields: string[] = [];
  const values: unknown[] = [];

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      values.push(value);
      fields.push(`${key} = $${values.length}`);
    }
  });

  if (fields.length === 0) return findUserById(id);

  values.push(id);
  const { rows } = await query<DbUserRow>(
    `update users set ${fields.join(', ')}
     where id = $${values.length}
       and deletion_status = 'active'
     returning ${userColumns}`,
    values
  );

  return rows[0] ? toDbUser(rows[0]) : null;
};

interface ReplaceUserAvatarOptions {
  runInTransaction?: typeof withTransaction;
  enqueueCleanupWithClient?: typeof enqueueAvatarCleanupWithClient;
}

export const replaceUserAvatar = async (
  id: string,
  input: { avatarUrl: string; objectKey: string },
  options: ReplaceUserAvatarOptions = {}
) => {
  const runInTransaction = options.runInTransaction || withTransaction;
  const enqueueCleanupWithClient = options.enqueueCleanupWithClient
    || enqueueAvatarCleanupWithClient;

  return runInTransaction(async (client) => {
    const { rows: currentRows } = await client.query<{
      id: string;
      avatar_object_key?: string | null;
    }>(
      `select id, avatar_object_key
       from users
       where id = $1
         and deletion_status = 'active'
       for update`,
      [id]
    );
    const current = currentRows[0];
    if (!current) return null;

    const { rows } = await client.query<DbUserRow>(
      `update users
       set avatar_url = $2,
           avatar_object_key = $3
       where id = $1
         and deletion_status = 'active'
       returning ${userColumns}`,
      [id, input.avatarUrl, input.objectKey]
    );
    const userRow = rows[0];
    if (!userRow) return null;
    const user = toDbUser(userRow);

    const previousObjectKey = current.avatar_object_key || null;
    const cleanupJob = previousObjectKey && previousObjectKey !== input.objectKey
      ? await enqueueCleanupWithClient(client, previousObjectKey)
      : null;
    return { user, previousObjectKey, cleanupJob };
  });
};
