import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { normalizeSearchQuery, readSearchFilters } from '../lib/searchInput';
import { searchMessagesForUser } from '../repositories/messages';
import { toSafeError } from '../lib/safeError';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const normalizedQuery = normalizeSearchQuery(req.query.q);

    if (!normalizedQuery.ok) {
      res.status(normalizedQuery.statusCode).json({ error: normalizedQuery.error });
      return;
    }

    const results = await searchMessagesForUser(req.user.id, normalizedQuery.query, readSearchFilters(req.query));
    res.json(results);
  } catch (err) {
    console.error('[Search] Unexpected error:', toSafeError(err, res.locals.requestId));
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
