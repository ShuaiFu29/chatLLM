import { query } from '../lib/db';

export interface ProjectSpaceRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  is_default: boolean;
  status: 'active' | 'deleting';
  knowledge_version: number;
  knowledge_version_updated_at: string;
  created_at: string;
  updated_at: string;
}

const columns = `
  id,
  user_id,
  name,
  description,
  is_default,
  status,
  knowledge_version,
  knowledge_version_updated_at,
  created_at,
  updated_at
`;

export const DEFAULT_PROJECT_SPACE_NAME = 'General';

export const listProjectSpacesForUser = async (userId: string) => {
  const { rows } = await query<ProjectSpaceRow>(
    `select ${columns}
     from project_spaces
     where user_id = $1
       and status = 'active'
     order by is_default desc, updated_at desc, name asc`,
    [userId]
  );
  return rows;
};

export const findProjectSpaceForUser = async (projectSpaceId: string, userId: string) => {
  const { rows } = await query<ProjectSpaceRow>(
    `select ${columns}
     from project_spaces
     where id = $1
       and user_id = $2
       and status = 'active'`,
    [projectSpaceId, userId]
  );
  return rows[0] || null;
};

export const findProjectSpaceForUserIncludingDeleting = async (
  projectSpaceId: string,
  userId: string
) => {
  const { rows } = await query<ProjectSpaceRow>(
    `select ${columns}
     from project_spaces
     where id = $1 and user_id = $2`,
    [projectSpaceId, userId]
  );
  return rows[0] || null;
};

export const ensureDefaultProjectSpaceForUser = async (userId: string) => {
  const { rows } = await query<ProjectSpaceRow>(
    `insert into project_spaces (user_id, name, description, is_default)
     values ($1, $2, '', true)
     on conflict (user_id) where is_default
     do update set updated_at = project_spaces.updated_at
     returning ${columns}`,
    [userId, DEFAULT_PROJECT_SPACE_NAME]
  );

  if (rows[0]) return rows[0];

  const fallback = await query<ProjectSpaceRow>(
    `select ${columns}
     from project_spaces
     where user_id = $1 and is_default = true
     limit 1`,
    [userId]
  );
  return fallback.rows[0];
};

export const createProjectSpaceForUser = async (
  userId: string,
  input: { name: string; description?: string }
) => {
  const { rows } = await query<ProjectSpaceRow>(
    `insert into project_spaces (user_id, name, description)
     values ($1, $2, $3)
     returning ${columns}`,
    [userId, input.name, input.description || '']
  );
  return rows[0];
};

export const updateProjectSpaceForUser = async (
  projectSpaceId: string,
  userId: string,
  updates: { name?: string; description?: string }
) => {
  const fields: string[] = ['updated_at = now()'];
  const values: unknown[] = [];

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      values.push(value);
      fields.push(`${key} = $${values.length}`);
    }
  });

  values.push(projectSpaceId, userId);
  const { rows } = await query<ProjectSpaceRow>(
    `update project_spaces
     set ${fields.join(', ')}
     where id = $${values.length - 1}
       and user_id = $${values.length}
       and status = 'active'
     returning ${columns}`,
    values
  );
  return rows[0] || null;
};
