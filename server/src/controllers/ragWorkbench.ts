import { AppReply, AppRequest } from '../common/http/app-request';
import { normalizeChatMessageContent } from '../lib/chatInput';
import { listRagGraphDocuments, retrieveAgenticRagDocuments, searchRagGraphDocuments } from '../lib/ragClient';
import { toSafeError } from '../lib/safeError';
import { findProjectSpaceForUser } from '../repositories/projectSpaces';

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const resolveProjectSpaceId = async (req: AppRequest) => {
  if (!req.user) return undefined;
  const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId);
  if (!requestedProjectSpaceId) return undefined;

  const space = await findProjectSpaceForUser(requestedProjectSpaceId, req.user.id);
  return space?.id || null;
};

export const inspectRagRetrieval = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  const normalizedQuery = normalizeChatMessageContent(req.body.query);
  if (!normalizedQuery.ok) {
    return res.code(normalizedQuery.statusCode).send({ error: normalizedQuery.error });
  }

  try {
    const projectSpaceId = await resolveProjectSpaceId(req);
    if (projectSpaceId === null) return res.code(404).send({ error: 'Project space not found' });

    const result = await retrieveAgenticRagDocuments({
      query: normalizedQuery.content,
      user_id: req.user.id,
      project_space_id: projectSpaceId || undefined,
      limit: req.body.limit ?? 10,
      threshold: req.body.threshold ?? 0.1,
    });

    res.send(result);
  } catch (error) {
    console.error('Error inspecting RAG retrieval:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to inspect RAG retrieval' });
  }
};

export const searchRagGraph = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  const normalizedQuery = normalizeChatMessageContent(req.body.query);
  if (!normalizedQuery.ok) {
    return res.code(normalizedQuery.statusCode).send({ error: normalizedQuery.error });
  }

  try {
    const projectSpaceId = await resolveProjectSpaceId(req);
    if (projectSpaceId === null) return res.code(404).send({ error: 'Project space not found' });

    const results = await searchRagGraphDocuments({
      query: normalizedQuery.content,
      user_id: req.user.id,
      project_space_id: projectSpaceId || undefined,
      limit: req.body.limit ?? 10,
      threshold: 0,
    });

    res.send({ results });
  } catch (error) {
    console.error('Error searching RAG graph:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to search RAG graph' });
  }
};

export const listRagGraph = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const projectSpaceId = await resolveProjectSpaceId(req);
    if (projectSpaceId === null) return res.code(404).send({ error: 'Project space not found' });

    const results = await listRagGraphDocuments({
      user_id: req.user.id,
      project_space_id: projectSpaceId || undefined,
      limit: req.body.limit ?? 30,
    });

    res.send({ results });
  } catch (error) {
    console.error('Error listing RAG graph:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to list RAG graph' });
  }
};
