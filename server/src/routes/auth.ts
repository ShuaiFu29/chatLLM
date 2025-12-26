import { Router } from 'express';
import { githubLogin, githubCallback, getMe, logout, refreshToken, updateProfile, deleteAccount } from '../controllers/auth';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/github/login', githubLogin);
router.get('/github/callback', githubCallback);
router.post('/refresh', refreshToken);
router.get('/me', requireAuth, getMe);
router.put('/me', requireAuth, updateProfile);
router.delete('/me', requireAuth, deleteAccount);
router.post('/logout', logout);

export default router;
