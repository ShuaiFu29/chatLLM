import { AppReply, AppRequest } from '../common/http/app-request';
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

export const listPromptTemplates = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const templates = await listPromptTemplatesForUser(req.user.id);
    res.send(templates);
  } catch (error) {
    console.error('Error listing prompt templates:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to list prompt templates' });
  }
};

export const createPromptTemplate = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

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
    res.code(201).send(template);
  } catch (error) {
    console.error('Error creating prompt template:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to create prompt template' });
  }
};

export const updatePromptTemplate = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
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
    if (!template) return res.code(404).send({ error: 'Prompt template not found' });
    res.send(template);
  } catch (error) {
    console.error('Error updating prompt template:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update prompt template' });
  }
};

export const deletePromptTemplate = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const { templateId } = req.params;

  try {
    const deleted = await deletePromptTemplateForUser(templateId, req.user.id);
    if (!deleted) return res.code(404).send({ error: 'Prompt template not found' });
    res.send({ success: true });
  } catch (error) {
    console.error('Error deleting prompt template:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete prompt template' });
  }
};
