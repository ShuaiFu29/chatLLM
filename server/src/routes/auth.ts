import { Router } from 'express';
import { githubLogin, githubCallback, getMe, logout, refreshToken, updateProfile, deleteAccount } from '../controllers/auth';
import { mutationSchemas } from '../lib/mutationSchemas';
import { validateMutation } from '../lib/validation';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/github/login', githubLogin);
router.get('/github/callback', githubCallback);
router.post('/refresh', validateMutation(mutationSchemas.authRefresh), refreshToken);
router.get('/me', requireAuth, getMe);
router.put('/me', requireAuth, validateMutation(mutationSchemas.authUpdateProfile), updateProfile);
router.delete('/me', requireAuth, validateMutation(mutationSchemas.authDeleteAccount), deleteAccount);
router.post('/logout', validateMutation(mutationSchemas.authLogout), logout);

export default router;
