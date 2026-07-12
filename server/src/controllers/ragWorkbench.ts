import { Request, Response } from 'express';
import { normalizeChatMessageContent } from '../lib/chatInput';
import { listRagGraphDocuments, retrieveAgenticRagDocuments, searchRagGraphDocuments } from '../lib/ragClient';
import { toSafeError } from '../lib/safeError';
import { findProjectSpaceForUser } from '../repositories/projectSpaces';

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const readLimit = (value: unknown, defaultValue = 10) => {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, 30);
};

const resolveProjectSpaceId = async (req: Request) => {
  if (!req.user) return undefined;
  const requestedProjectSpaceId = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId);
  if (!requestedProjectSpaceId) return undefined;

  const space = await findProjectSpaceForUser(requestedProjectSpaceId, req.user.id);
  return space?.id || null;
};

export const inspectRagRetrieval = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const normalizedQuery = normalizeChatMessageContent(req.body.query);
  if (!normalizedQuery.ok) {
    return res.status(normalizedQuery.statusCode).json({ error: normalizedQuery.error });
  }

  try {
    const projectSpaceId = await resolveProjectSpaceId(req);
    if (projectSpaceId === null) return res.status(404).json({ error: 'Project space not found' });

    const result = await retrieveAgenticRagDocuments({
      query: normalizedQuery.content,
      user_id: req.user.id,
      project_space_id: projectSpaceId || undefined,
      limit: readLimit(req.body.limit, 10),
      threshold: typeof req.body.threshold === 'number' ? req.body.threshold : 0.1,
    });

    res.json(result);
  } catch (error) {
    console.error('Error inspecting RAG retrieval:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to inspect RAG retrieval' });
  }
};

export const searchRagGraph = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const normalizedQuery = normalizeChatMessageContent(req.body.query);
  if (!normalizedQuery.ok) {
    return res.status(normalizedQuery.statusCode).json({ error: normalizedQuery.error });
  }

  try {
    const projectSpaceId = await resolveProjectSpaceId(req);
    if (projectSpaceId === null) return res.status(404).json({ error: 'Project space not found' });

    const results = await searchRagGraphDocuments({
      query: normalizedQuery.content,
      user_id: req.user.id,
      project_space_id: projectSpaceId || undefined,
      limit: readLimit(req.body.limit, 10),
      threshold: 0,
    });

    res.json({ results });
  } catch (error) {
    console.error('Error searching RAG graph:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to search RAG graph' });
  }
};

export const listRagGraph = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const projectSpaceId = await resolveProjectSpaceId(req);
    if (projectSpaceId === null) return res.status(404).json({ error: 'Project space not found' });

    const results = await listRagGraphDocuments({
      user_id: req.user.id,
      project_space_id: projectSpaceId || undefined,
      limit: readLimit(req.body.limit, 30),
    });

    res.json({ results });
  } catch (error) {
    console.error('Error listing RAG graph:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to list RAG graph' });
  }
};
