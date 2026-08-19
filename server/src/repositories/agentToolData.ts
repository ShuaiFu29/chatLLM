import { query } from '../lib/db';

export interface AgentDocumentExcerptRow {
  file_id: string;
  filename: string;
  chunk_id: string;
  chunk_index: number;
  content: string;
  source_locator: Record<string, unknown>;
}

export const listDocumentExcerptsForAgent = async (input: {
  userId: string;
  projectSpaceId: string;
  fileId: string;
  search?: string;
  limit: number;
}) => {
  const values: unknown[] = [input.userId, input.projectSpaceId, input.fileId];
  let searchFilter = '';
  if (input.search) {
    values.push(`%${input.search}%`);
    searchFilter = `and chunk.content ilike $${values.length}`;
  }
  values.push(input.limit);
  const { rows } = await query<AgentDocumentExcerptRow>(
    `select
       file.id as file_id,
       file.filename,
       chunk.id as chunk_id,
       chunk.chunk_index,
       chunk.content,
       chunk.source_locator
     from files file
     join file_chunks chunk
       on chunk.file_id = file.id
      and chunk.conversion_generation_id = file.active_conversion_generation_id
     where file.user_id = $1
       and file.project_space_id = $2
       and file.id = $3
       and file.status = 'completed'
       ${searchFilter}
     order by chunk.chunk_index asc
     limit $${values.length}`,
    values,
  );
  return rows;
};

export const getProjectContextForAgent = async (
  userId: string,
  projectSpaceId: string,
) => {
  const { rows } = await query<{
    id: string;
    name: string;
    description: string;
    document_count: number;
    conversation_count: number;
    completed_document_count: number;
  }>(
    `select
       project.id,
       project.name,
       project.description,
       count(distinct file.id)::integer as document_count,
       count(distinct conversation.id)::integer as conversation_count,
       count(distinct file.id) filter (where file.status = 'completed')::integer as completed_document_count
     from project_spaces project
     left join files file
       on file.project_space_id = project.id
      and file.user_id = project.user_id
      and file.status <> 'deleting'
     left join conversations conversation
       on conversation.project_space_id = project.id
      and conversation.user_id = project.user_id
      and conversation.archived_at is null
     where project.id = $1
       and project.user_id = $2
       and project.status = 'active'
     group by project.id, project.name, project.description`,
    [projectSpaceId, userId],
  );
  return rows[0] || null;
};
