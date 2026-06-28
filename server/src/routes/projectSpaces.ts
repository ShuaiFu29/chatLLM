import { Router } from 'express';
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
router.post('/', createProjectSpace);
router.patch('/:projectSpaceId', updateProjectSpace);
router.delete('/:projectSpaceId', deleteProjectSpace);

export default router;
