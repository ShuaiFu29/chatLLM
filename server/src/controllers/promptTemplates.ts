import { Request, Response } from 'express';
import {
  createPromptTemplateForUser,
  deletePromptTemplateForUser,
  listPromptTemplatesForUser,
  updatePromptTemplateForUser,
} from '../repositories/promptTemplates';
import { toSafeError } from '../lib/safeError';

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || null;
};

export const listPromptTemplates = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const templates = await listPromptTemplatesForUser(req.user.id);
    res.json(templates);
  } catch (error) {
    console.error('Error listing prompt templates:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to list prompt templates' });
  }
};

export const createPromptTemplate = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const name = req.body.name as string;
  const content = req.body.content as string;
  const description = (req.body.description ?? '') as string;

  try {
    const template = await createPromptTemplateForUser({
      userId: req.user.id,
      projectSpaceId: readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId),
      name,
      content,
      description,
      isDefault: req.body.is_default ?? req.body.isDefault ?? false,
    });
    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating prompt template:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to create prompt template' });
  }
};

export const updatePromptTemplate = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { templateId } = req.params;

  const updates: {
    project_space_id?: string | null;
    name?: string;
    content?: string;
    description?: string;
    is_default?: boolean;
  } = {};

  if (req.body.project_space_id !== undefined || req.body.projectSpaceId !== undefined) {
    updates.project_space_id = readProjectSpaceId(req.body.project_space_id ?? req.body.projectSpaceId) ?? null;
  }
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.content !== undefined) updates.content = req.body.content;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.is_default !== undefined || req.body.isDefault !== undefined) {
    updates.is_default = req.body.is_default ?? req.body.isDefault;
  }

  try {
    const template = await updatePromptTemplateForUser(templateId, req.user.id, updates);
    if (!template) return res.status(404).json({ error: 'Prompt template not found' });
    res.json(template);
  } catch (error) {
    console.error('Error updating prompt template:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to update prompt template' });
  }
};

export const deletePromptTemplate = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { templateId } = req.params;

  try {
    const deleted = await deletePromptTemplateForUser(templateId, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Prompt template not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting prompt template:', toSafeError(error, res.locals.requestId));
    res.status(500).json({ error: 'Failed to delete prompt template' });
  }
};
