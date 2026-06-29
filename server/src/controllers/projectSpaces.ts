import { Request, Response } from 'express';
import axios from 'axios';
import { cleanupRagFileVectors } from '../lib/ragClient';
import { deleteObject } from '../lib/storage';
import { listFilesForUser } from '../repositories/files';
import {
  createProjectSpaceForUser,
  deleteProjectSpaceForUser,
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
  listProjectSpacesForUser,
  updateProjectSpaceForUser,
} from '../repositories/projectSpaces';

const normalizeName = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 80);
};

const normalizeDescription = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 500);
};

export const listProjectSpaces = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await ensureDefaultProjectSpaceForUser(req.user.id);
    const spaces = await listProjectSpacesForUser(req.user.id);
    res.json(spaces);
  } catch (error) {
    console.error('[ProjectSpaces] Failed to list spaces:', error);
    res.status(500).json({ error: 'Failed to list project spaces' });
  }
};

export const createProjectSpace = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const name = normalizeName(req.body.name);
  const description = normalizeDescription(req.body.description);
  if (!name) return res.status(400).json({ error: 'Project space name is required' });

  try {
    await ensureDefaultProjectSpaceForUser(req.user.id);
    const space = await createProjectSpaceForUser(req.user.id, { name, description });
    res.status(201).json(space);
  } catch (error) {
    console.error('[ProjectSpaces] Failed to create space:', error);
    res.status(500).json({ error: 'Failed to create project space' });
  }
};

export const updateProjectSpace = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { projectSpaceId } = req.params;
  const updates: { name?: string; description?: string } = {};

  if (req.body.name !== undefined) {
    const name = normalizeName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Project space name is required' });
    updates.name = name;
  }

  if (req.body.description !== undefined) {
    updates.description = normalizeDescription(req.body.description);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const current = await findProjectSpaceForUser(projectSpaceId, req.user.id);
    if (!current) return res.status(404).json({ error: 'Project space not found' });
    if (current.is_default && updates.name && updates.name !== current.name) {
      return res.status(400).json({ error: 'Default project space cannot be renamed' });
    }

    const space = await updateProjectSpaceForUser(projectSpaceId, req.user.id, updates);
    res.json(space);
  } catch (error) {
    console.error('[ProjectSpaces] Failed to update space:', error);
    res.status(500).json({ error: 'Failed to update project space' });
  }
};

export const deleteProjectSpace = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const current = await findProjectSpaceForUser(req.params.projectSpaceId, req.user.id);
    if (!current) return res.status(404).json({ error: 'Project space not found' });
    if (current.is_default) return res.status(400).json({ error: 'Default workspace cannot be deleted' });

    const files = await listFilesForUser(req.user.id, req.params.projectSpaceId);
    for (const file of files) {
      await cleanupRagFileVectors(file.id);
      if (file.object_key) {
        await deleteObject(file.object_key);
      }
    }

    const deleted = await deleteProjectSpaceForUser(req.params.projectSpaceId, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Project space not found' });
    res.json({ success: true });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return res.status(502).json({ error: 'Workspace file cleanup failed; workspace was not deleted' });
    }
    console.error('[ProjectSpaces] Failed to delete space:', error);
    res.status(500).json({ error: 'Failed to delete project space' });
  }
};
