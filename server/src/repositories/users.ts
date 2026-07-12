import { query } from '../lib/db';
import { User } from '../types';

export interface DbUser extends User {
  avatar_object_key?: string | null;
  deletion_status: 'active' | 'pending';
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

export const findUserByGithubId = async (githubId: number) => {
  const { rows } = await query<DbUser>(
    `select ${userColumns} from users where github_id = $1`,
    [githubId]
  );
  return rows[0] || null;
};

export const findUserById = async (id: string) => {
  const { rows } = await query<DbUser>(
    `select ${userColumns} from users where id = $1`,
    [id]
  );
  return rows[0] || null;
};

export const createUser = async (input: {
  github_id: number;
  username: string;
  avatar_url: string;
  display_name?: string | null;
}) => {
  const { rows } = await query<DbUser>(
    `insert into users (github_id, username, avatar_url, display_name)
     values ($1, $2, $3, $4)
     returning ${userColumns}`,
    [input.github_id, input.username, input.avatar_url, input.display_name || input.username]
  );
  return rows[0];
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
  const { rows } = await query<DbUser>(
    `update users set ${fields.join(', ')}
     where id = $${values.length}
       and deletion_status = 'active'
     returning ${userColumns}`,
    values
  );

  return rows[0] || null;
};
