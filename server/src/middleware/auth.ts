import { Request, Response, NextFunction } from 'express';
import { User } from '../types';
import { verifyAccessToken } from '../lib/jwt';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const accessToken = req.cookies.access_token;

  if (!accessToken) {
    res.status(401).json({ error: 'Unauthorized: No access token' });
    return;
  }

  const user = verifyAccessToken(accessToken);

  if (!user) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  req.user = user;
  next();
};
