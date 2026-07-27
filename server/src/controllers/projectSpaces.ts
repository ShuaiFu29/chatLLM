import { AppReply, AppRequest } from '../common/http/app-request';
import { toSafeError } from '../lib/safeError';
import { enqueueProjectSpaceCleanup } from '../repositories/cleanupJobs';
import {
  createProjectSpaceForUser,
  ensureDefaultProjectSpaceForUser,
  findProjectSpaceForUser,
  findProjectSpaceForUserIncludingDeleting,
  listProjectSpacesForUser,
  updateProjectSpaceForUser,
} from '../repositories/projectSpaces';
import { artifactCleanupQueue } from '../services/cleanupQueue';

export const listProjectSpaces = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    await ensureDefaultProjectSpaceForUser(req.user.id);
    const spaces = await listProjectSpacesForUser(req.user.id);
    res.send(spaces);
  } catch (error) {
    console.error('[ProjectSpaces] Failed to list spaces:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to list project spaces' });
  }
};

export const createProjectSpace = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  const name = req.body.name as string;
  const description = (req.body.description ?? '') as string;

  try {
    await ensureDefaultProjectSpaceForUser(req.user.id);
    const space = await createProjectSpaceForUser(req.user.id, { name, description });
    res.code(201).send(space);
  } catch (error) {
    console.error('[ProjectSpaces] Failed to create space:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to create project space' });
  }
};

export const updateProjectSpace = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  const { projectSpaceId } = req.params;
  const updates: { name?: string; description?: string } = {};

  if (req.body.name !== undefined) {
    updates.name = req.body.name;
  }

  if (req.body.description !== undefined) {
    updates.description = req.body.description;
  }

  if (Object.keys(updates).length === 0) {
    return res.code(400).send({ error: 'No fields to update' });
  }

  try {
    const current = await findProjectSpaceForUser(projectSpaceId, req.user.id);
    if (!current) return res.code(404).send({ error: 'Project space not found' });
    if (current.status !== 'active') return res.code(409).send({ error: 'Project space is being deleted' });
    if (current.is_default && updates.name && updates.name !== current.name) {
      return res.code(400).send({ error: 'Default project space cannot be renamed' });
    }

    const space = await updateProjectSpaceForUser(projectSpaceId, req.user.id, updates);
    res.send(space);
  } catch (error) {
    console.error('[ProjectSpaces] Failed to update space:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update project space' });
  }
};

export const deleteProjectSpace = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const current = await findProjectSpaceForUserIncludingDeleting(
      req.params.projectSpaceId,
      req.user.id
    );
    if (!current) return res.code(404).send({ error: 'Project space not found' });
    if (current.is_default) return res.code(400).send({ error: 'Default workspace cannot be deleted' });

    const cleanup = await enqueueProjectSpaceCleanup(req.params.projectSpaceId, req.user.id);
    if (!cleanup) return res.code(404).send({ error: 'Project space not found' });
    artifactCleanupQueue.trigger();
    res.code(202).send({
      status: 'deleting',
      cleanup_job_id: cleanup.job.id,
      child_jobs: cleanup.childCount,
    });
  } catch (error) {
    console.error('[ProjectSpaces] Failed to delete space:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete project space' });
  }
};
