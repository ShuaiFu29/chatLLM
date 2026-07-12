import { createHash } from 'crypto';
import { query, withTransaction } from '../lib/db';
import { DbUser } from './users';

export interface DbSession {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface SessionWithUser extends DbSession {
  user: DbUser;
}

interface SessionUserRow extends DbSession {
  user_id_actual: string;
  github_id: number | string;
  username: string;
  avatar_url: string;
  avatar_object_key?: string | null;
  display_name?: string;
  settings?: DbUser['settings'];
  deletion_status: 'active' | 'pending';
  user_created_at?: string;
}

const toSessionWithUser = (row: SessionUserRow): SessionWithUser => ({
  id: row.id,
  user_id: row.user_id,
  expires_at: row.expires_at,
  created_at: row.created_at,
  user: {
    id: row.user_id_actual,
    github_id: Number(row.github_id),
    username: row.username,
    avatar_url: row.avatar_url,
    avatar_object_key: row.avatar_object_key,
    display_name: row.display_name,
    settings: row.settings,
    deletion_status: row.deletion_status,
    created_at: row.user_created_at,
  },
});

export const hashRefreshToken = (rawToken: string) =>
  createHash('sha256').update(rawToken, 'utf8').digest('hex');

export const createSession = async (
  rawToken: string,
  userId: string,
  expiresAt: string,
  runInTransaction: typeof withTransaction = withTransaction
) => {
  await runInTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `select id
       from users
       where id = $1
         and deletion_status = 'active'
       for update`,
      [userId]
    );
    if (!user.rows[0]) throw new Error('Session user is unavailable');

    await client.query(
      `insert into sessions (token_hash, user_id, expires_at)
       values ($1, $2, $3)`,
      [hashRefreshToken(rawToken), userId, expiresAt]
    );
  });
};

export const findSessionWithUser = async (rawToken: string) => {
  const { rows } = await query<SessionUserRow>(
    `select
       s.id,
       s.user_id,
       s.expires_at,
       s.created_at,
       u.id as user_id_actual,
       u.github_id,
       u.username,
       u.avatar_url,
       u.avatar_object_key,
       u.display_name,
       u.settings,
       u.deletion_status,
       u.created_at as user_created_at
     from sessions s
     join users u on u.id = s.user_id
     where s.token_hash = $1
       and u.deletion_status = 'active'`,
    [hashRefreshToken(rawToken)]
  );

  const row = rows[0];
  if (!row) return null;

  return toSessionWithUser(row);
};

export const rotateSession = async (
  oldRawToken: string,
  newRawToken: string,
  expiresAt: string,
  runInTransaction: typeof withTransaction = withTransaction
): Promise<SessionWithUser | null> => {
  return runInTransaction(async (client) => {
    const { rows: candidateRows } = await client.query<{ user_id: string }>(
      `select user_id
       from sessions
       where token_hash = $1
         and expires_at > now()`,
      [hashRefreshToken(oldRawToken)]
    );
    const candidate = candidateRows[0];
    if (!candidate) return null;

    const { rows: userRows } = await client.query<DbUser>(
      `select
         id,
         github_id,
         username,
         avatar_url,
         avatar_object_key,
         display_name,
         settings,
         deletion_status,
         created_at
       from users
       where id = $1
         and deletion_status = 'active'
       for update`,
      [candidate.user_id]
    );
    const user = userRows[0];
    if (!user) return null;

    const { rows: consumedRows } = await client.query<{ user_id: string }>(
      `delete from sessions
       where token_hash = $1
         and user_id = $2
         and expires_at > now()
       returning user_id`,
      [hashRefreshToken(oldRawToken), candidate.user_id]
    );
    const consumed = consumedRows[0];
    if (!consumed) return null;

    const { rows: sessionRows } = await client.query<DbSession>(
      `insert into sessions (token_hash, user_id, expires_at)
       values ($1, $2, $3)
       returning id, user_id, expires_at, created_at`,
      [hashRefreshToken(newRawToken), consumed.user_id, expiresAt]
    );
    const session = sessionRows[0];

    if (!session || !user) {
      throw new Error('Rotated session user is unavailable');
    }

    return {
      ...session,
      user: {
        ...user,
        github_id: Number(user.github_id),
      },
    };
  });
};

export const deleteSession = async (rawToken: string) => {
  await query('delete from sessions where token_hash = $1', [hashRefreshToken(rawToken)]);
};

export const deleteSessionsByUser = async (userId: string) => {
  await query('delete from sessions where user_id = $1', [userId]);
};

export const deleteExpiredSessions = async () => {
  const { rowCount } = await query('delete from sessions where expires_at < now()');
  return rowCount || 0;
};
