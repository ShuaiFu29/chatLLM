import { Router } from 'express';
import { mutationSchemas } from '../lib/mutationSchemas';
import { validateMutation } from '../lib/validation';
import { requireAuth } from '../middleware/auth';
import {
  createProjectSpace,
  deleteProjectSpace,
  listProjectSpaces,
  updateProjectSpace,
} from '../controllers/projectSpaces';

const router = Router();

router.use(requireAuth);

router.get('/', listProjectSpaces);
router.post('/', validateMutation(mutationSchemas.projectSpaceCreate), createProjectSpace);
router.patch('/:projectSpaceId', validateMutation(mutationSchemas.projectSpaceUpdate), updateProjectSpace);
router.delete('/:projectSpaceId', validateMutation(mutationSchemas.projectSpaceDelete), deleteProjectSpace);

export default router;
