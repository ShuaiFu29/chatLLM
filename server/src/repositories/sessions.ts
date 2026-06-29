import { query } from '../lib/db';
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

export const createSession = async (id: string, userId: string, expiresAt: string) => {
  await query(
    `insert into sessions (id, user_id, expires_at)
     values ($1, $2, $3)`,
    [id, userId, expiresAt]
  );
};

export const findSessionWithUser = async (id: string) => {
  const { rows } = await query<any>(
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
       u.created_at as user_created_at
     from sessions s
     join users u on u.id = s.user_id
     where s.id = $1`,
    [id]
  );

  const row = rows[0];
  if (!row) return null;

  return {
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
      created_at: row.user_created_at,
    },
  } as SessionWithUser;
};

export const deleteSession = async (id: string) => {
  await query('delete from sessions where id = $1', [id]);
};

export const deleteSessionsByUser = async (userId: string) => {
  await query('delete from sessions where user_id = $1', [userId]);
};

export const deleteExpiredSessions = async () => {
  const { rowCount } = await query('delete from sessions where expires_at < now()');
  return rowCount || 0;
};
