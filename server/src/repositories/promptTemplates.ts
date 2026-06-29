import { query } from '../lib/db';

export interface PromptTemplateRow {
  id: string;
  user_id: string;
  project_space_id?: string | null;
  name: string;
  content: string;
  description: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const columns = `
  id,
  user_id,
  project_space_id,
  name,
  content,
  description,
  is_default,
  created_at,
  updated_at
`;

export const listPromptTemplatesForUser = async (userId: string) => {
  const { rows } = await query<PromptTemplateRow>(
    `select ${columns}
     from prompt_templates
     where user_id = $1
     order by is_default desc, updated_at desc`,
    [userId]
  );
  return rows;
};

export const createPromptTemplateForUser = async (input: {
  userId: string;
  projectSpaceId?: string | null;
  name: string;
  content: string;
  description?: string;
  isDefault?: boolean;
}) => {
  const { rows } = await query<PromptTemplateRow>(
    `insert into prompt_templates (user_id, project_space_id, name, content, description, is_default)
     values ($1, $2, $3, $4, $5, $6)
     returning ${columns}`,
    [
      input.userId,
      input.projectSpaceId || null,
      input.name,
      input.content,
      input.description || '',
      Boolean(input.isDefault),
    ]
  );
  return rows[0];
};

export const updatePromptTemplateForUser = async (
  templateId: string,
  userId: string,
  updates: Partial<Pick<PromptTemplateRow, 'project_space_id' | 'name' | 'content' | 'description' | 'is_default'>>
) => {
  const fields: string[] = ['updated_at = now()'];
  const values: unknown[] = [];

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      values.push(value);
      fields.push(`${key} = $${values.length}`);
    }
  });

  values.push(templateId, userId);
  const { rows } = await query<PromptTemplateRow>(
    `update prompt_templates
     set ${fields.join(', ')}
     where id = $${values.length - 1}
       and user_id = $${values.length}
     returning ${columns}`,
    values
  );

  return rows[0] || null;
};

export const deletePromptTemplateForUser = async (templateId: string, userId: string) => {
  const { rowCount } = await query(
    `delete from prompt_templates
     where id = $1 and user_id = $2`,
    [templateId, userId]
  );

  return (rowCount ?? 0) > 0;
};
