import { Request, Response } from 'express';
import {
  createPromptTemplateForUser,
  deletePromptTemplateForUser,
  listPromptTemplatesForUser,
  updatePromptTemplateForUser,
} from '../repositories/promptTemplates';

const cleanText = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

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
    console.error('Error listing prompt templates:', error);
    res.status(500).json({ error: 'Failed to list prompt templates' });
  }
};

export const createPromptTemplate = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const name = cleanText(req.body.name, 120);
  const content = cleanText(req.body.content, 8000);
  const description = cleanText(req.body.description, 500);

  if (!name || !content) {
    res.status(400).json({ error: 'Name and content are required' });
    return;
  }

  try {
    const template = await createPromptTemplateForUser({
      userId: req.user.id,
      projectSpaceId: readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId),
      name,
      content,
      description,
      isDefault: Boolean(req.body.is_default || req.body.isDefault),
    });
    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating prompt template:', error);
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
    updates.project_space_id = readProjectSpaceId(req.body.project_space_id || req.body.projectSpaceId) ?? null;
  }
  if (req.body.name !== undefined) updates.name = cleanText(req.body.name, 120);
  if (req.body.content !== undefined) updates.content = cleanText(req.body.content, 8000);
  if (req.body.description !== undefined) updates.description = cleanText(req.body.description, 500);
  if (req.body.is_default !== undefined || req.body.isDefault !== undefined) {
    updates.is_default = Boolean(req.body.is_default || req.body.isDefault);
  }

  if (updates.name === '' || updates.content === '') {
    res.status(400).json({ error: 'Name and content cannot be empty' });
    return;
  }

  try {
    const template = await updatePromptTemplateForUser(templateId, req.user.id, updates);
    if (!template) return res.status(404).json({ error: 'Prompt template not found' });
    res.json(template);
  } catch (error) {
    console.error('Error updating prompt template:', error);
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
    console.error('Error deleting prompt template:', error);
    res.status(500).json({ error: 'Failed to delete prompt template' });
  }
};
