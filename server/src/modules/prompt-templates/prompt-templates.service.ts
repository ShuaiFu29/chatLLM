import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { toSafeError } from '../../lib/safeError';
import {
  createPromptTemplateForUser,
  deletePromptTemplateForUser,
  listPromptTemplatesForUser,
  updatePromptTemplateForUser,
} from '../../repositories/promptTemplates';

export interface PromptTemplateCreateBody {
  project_space_id?: string | null;
  projectSpaceId?: string | null;
  name: string;
  content: string;
  description?: string;
  is_default?: boolean;
  isDefault?: boolean;
}

export type PromptTemplateUpdateBody = Partial<PromptTemplateCreateBody>;

const readProjectSpaceId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || null;
};

@Injectable()
export class PromptTemplatesService {
  async list(userId: string, requestId?: string) {
    try {
      return await listPromptTemplatesForUser(userId);
    } catch (error) {
      console.error(
        'Error listing prompt templates:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to list prompt templates' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async create(
    userId: string,
    body: PromptTemplateCreateBody,
    requestId?: string,
  ) {
    try {
      return await createPromptTemplateForUser({
        userId,
        projectSpaceId: readProjectSpaceId(
          body.project_space_id ?? body.projectSpaceId,
        ),
        name: body.name,
        content: body.content,
        description: body.description ?? '',
        isDefault: body.is_default ?? body.isDefault ?? false,
      });
    } catch (error) {
      console.error(
        'Error creating prompt template:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to create prompt template' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async update(
    userId: string,
    templateId: string,
    body: PromptTemplateUpdateBody,
    requestId?: string,
  ) {
    const updates: {
      project_space_id?: string | null;
      name?: string;
      content?: string;
      description?: string;
      is_default?: boolean;
    } = {};

    if (
      body.project_space_id !== undefined
      || body.projectSpaceId !== undefined
    ) {
      updates.project_space_id = readProjectSpaceId(
        body.project_space_id ?? body.projectSpaceId,
      ) ?? null;
    }
    if (body.name !== undefined) updates.name = body.name;
    if (body.content !== undefined) updates.content = body.content;
    if (body.description !== undefined) updates.description = body.description;
    if (body.is_default !== undefined || body.isDefault !== undefined) {
      updates.is_default = body.is_default ?? body.isDefault;
    }

    try {
      const template = await updatePromptTemplateForUser(
        templateId,
        userId,
        updates,
      );
      if (!template) {
        throw new HttpException(
          { error: 'Prompt template not found' },
          HttpStatus.NOT_FOUND,
        );
      }
      return template;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(
        'Error updating prompt template:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to update prompt template' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async delete(userId: string, templateId: string, requestId?: string) {
    try {
      const deleted = await deletePromptTemplateForUser(templateId, userId);
      if (!deleted) {
        throw new HttpException(
          { error: 'Prompt template not found' },
          HttpStatus.NOT_FOUND,
        );
      }
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(
        'Error deleting prompt template:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to delete prompt template' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
