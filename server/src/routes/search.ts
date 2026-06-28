import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { searchMessagesForUser } from '../repositories/messages';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const results = await searchMessagesForUser(req.user.id, q);
    res.json(results);
  } catch (err) {
    console.error('[Search] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
