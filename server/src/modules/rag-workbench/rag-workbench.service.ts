import { HttpException, Injectable } from '@nestjs/common';
import { normalizeChatMessageContent } from '../../lib/chatInput';
import {
  listRagGraphDocuments,
  retrieveAgenticRagDocuments,
  searchRagGraphDocuments,
} from '../../lib/ragClient';
import { toSafeError } from '../../lib/safeError';
import { findProjectSpaceForUser } from '../../repositories/projectSpaces';

export interface RagWorkbenchBody {
  query?: unknown;
  project_space_id?: unknown;
  projectSpaceId?: unknown;
  limit?: number;
  threshold?: number;
}

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const requestError = (status: number, error: string) => (
  new HttpException({ error }, status)
);

@Injectable()
export class RagWorkbenchService {
  private async resolveProjectSpaceId(userId: string, body: RagWorkbenchBody) {
    const requestedProjectSpaceId = readProjectSpaceId(
      body.project_space_id ?? body.projectSpaceId,
    );
    if (!requestedProjectSpaceId) return undefined;

    const space = await findProjectSpaceForUser(requestedProjectSpaceId, userId);
    return space?.id || null;
  }

  async inspect(userId: string, body: RagWorkbenchBody, requestId?: string) {
    const normalizedQuery = normalizeChatMessageContent(body.query);
    if (!normalizedQuery.ok) {
      throw requestError(normalizedQuery.statusCode, normalizedQuery.error);
    }

    try {
      const projectSpaceId = await this.resolveProjectSpaceId(userId, body);
      if (projectSpaceId === null) {
        throw requestError(404, 'Project space not found');
      }

      return await retrieveAgenticRagDocuments({
        query: normalizedQuery.content,
        user_id: userId,
        project_space_id: projectSpaceId || undefined,
        limit: body.limit ?? 10,
        threshold: body.threshold ?? 0.1,
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error inspecting RAG retrieval:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to inspect RAG retrieval');
    }
  }

  async searchGraph(userId: string, body: RagWorkbenchBody, requestId?: string) {
    const normalizedQuery = normalizeChatMessageContent(body.query);
    if (!normalizedQuery.ok) {
      throw requestError(normalizedQuery.statusCode, normalizedQuery.error);
    }

    try {
      const projectSpaceId = await this.resolveProjectSpaceId(userId, body);
      if (projectSpaceId === null) {
        throw requestError(404, 'Project space not found');
      }

      const results = await searchRagGraphDocuments({
        query: normalizedQuery.content,
        user_id: userId,
        project_space_id: projectSpaceId || undefined,
        limit: body.limit ?? 10,
        threshold: 0,
      });
      return { results };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error searching RAG graph:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to search RAG graph');
    }
  }

  async listGraph(userId: string, body: RagWorkbenchBody, requestId?: string) {
    try {
      const projectSpaceId = await this.resolveProjectSpaceId(userId, body);
      if (projectSpaceId === null) {
        throw requestError(404, 'Project space not found');
      }

      const results = await listRagGraphDocuments({
        user_id: userId,
        project_space_id: projectSpaceId || undefined,
        limit: body.limit ?? 30,
      });
      return { results };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error listing RAG graph:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to list RAG graph');
    }
  }
}
