import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { toSafeError } from '../../lib/safeError';
import { enqueueProjectSpaceCleanup } from '../../repositories/cleanupJobs';
import {
  createProjectSpaceForUser,
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
  findProjectSpaceForUserIncludingDeleting,
  listProjectSpacesForUser,
  updateProjectSpaceForUser,
} from '../../repositories/projectSpaces';
import { artifactCleanupQueue } from '../../services/cleanupQueue';

export interface ProjectSpaceCreateBody {
  name: string;
  description?: string;
}

export interface ProjectSpaceUpdateBody {
  name?: string;
  description?: string;
}

@Injectable()
export class ProjectSpacesService {
  async list(userId: string, requestId?: string) {
    try {
      await ensureDefaultProjectSpaceForUser(userId);
      return await listProjectSpacesForUser(userId);
    } catch (error) {
      console.error(
        '[ProjectSpaces] Failed to list spaces:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to list project spaces' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async create(
    userId: string,
    body: ProjectSpaceCreateBody,
    requestId?: string,
  ) {
    try {
      await ensureDefaultProjectSpaceForUser(userId);
      return await createProjectSpaceForUser(userId, {
        name: body.name,
        description: body.description ?? '',
      });
    } catch (error) {
      console.error(
        '[ProjectSpaces] Failed to create space:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to create project space' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async update(
    userId: string,
    projectSpaceId: string,
    body: ProjectSpaceUpdateBody,
    requestId?: string,
  ) {
    const updates: ProjectSpaceUpdateBody = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;

    if (Object.keys(updates).length === 0) {
      throw new HttpException(
        { error: 'No fields to update' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const current = await findProjectSpaceForUser(projectSpaceId, userId);
      if (!current) {
        throw new HttpException(
          { error: 'Project space not found' },
          HttpStatus.NOT_FOUND,
        );
      }
      if (current.status !== 'active') {
        throw new HttpException(
          { error: 'Project space is being deleted' },
          HttpStatus.CONFLICT,
        );
      }
      if (current.is_default && updates.name && updates.name !== current.name) {
        throw new HttpException(
          { error: 'Default project space cannot be renamed' },
          HttpStatus.BAD_REQUEST,
        );
      }

      return await updateProjectSpaceForUser(
        projectSpaceId,
        userId,
        updates,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(
        '[ProjectSpaces] Failed to update space:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to update project space' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async delete(userId: string, projectSpaceId: string, requestId?: string) {
    try {
      const current = await findProjectSpaceForUserIncludingDeleting(
        projectSpaceId,
        userId,
      );
      if (!current) {
        throw new HttpException(
          { error: 'Project space not found' },
          HttpStatus.NOT_FOUND,
        );
      }
      if (current.is_default) {
        throw new HttpException(
          { error: 'Default workspace cannot be deleted' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const cleanup = await enqueueProjectSpaceCleanup(projectSpaceId, userId);
      if (!cleanup) {
        throw new HttpException(
          { error: 'Project space not found' },
          HttpStatus.NOT_FOUND,
        );
      }
      artifactCleanupQueue.trigger();
      return {
        status: 'deleting',
        cleanup_job_id: cleanup.job.id,
        child_jobs: cleanup.childCount,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(
        '[ProjectSpaces] Failed to delete space:',
        toSafeError(error, requestId),
      );
      throw new HttpException(
        { error: 'Failed to delete project space' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
