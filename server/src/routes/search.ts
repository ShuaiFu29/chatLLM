import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    console.log(`[Search] Executing search for: "${q}" user: ${req.user.id}`);

    // Perform the search
    const { data, error } = await supabase
      .from('messages')
      .select(`
        id,
        content,
        created_at,
        conversation_id,
        conversations!inner (
          id,
          title,
          user_id
        )
      `)
      .eq('conversations.user_id', req.user.id)
      // Use explicit ILIKE with wildcards for exact partial match
      // Also, we might want to ensure we are not matching internal system prompts if any
      .ilike('content', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('[Search] Database error:', error);
      res.status(500).json({ error: 'Database search failed' });
      return;
    }

    console.log(`[Search] Found ${data?.length || 0} results`);
    res.json(data || []);

  } catch (err) {
    console.error('[Search] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
