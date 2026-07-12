import { Request, Response, NextFunction } from 'express';
import { User } from '../types';
import { verifyAccessToken } from '../lib/jwt';
import { findUserById } from '../repositories/users';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

type FindUserById = typeof findUserById;

export const resolveAuthenticatedUser = async (
  accessToken: string,
  findUser: FindUserById = findUserById
) => {
  const tokenUser = verifyAccessToken(accessToken);
  if (!tokenUser) return null;

  const user = await findUser(tokenUser.id);
  if (!user || user.deletion_status !== 'active') return null;
  return user;
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const accessToken = req.cookies.access_token;

  if (!accessToken) {
    res.status(401).json({ error: 'Unauthorized: No access token' });
    return;
  }

  const user = await resolveAuthenticatedUser(accessToken);

  if (!user) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  req.user = user;
  next();
};
