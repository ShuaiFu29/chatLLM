import jwt from 'jsonwebtoken';
import { User } from '../types';
import { serverEnv } from './env';

const JWT_SECRET = serverEnv.JWT_SECRET;

// Access Token Duration (15 minutes)
const ACCESS_TOKEN_DURATION = '15m';

export const generateAccessToken = (user: User) => {
  return jwt.sign(
    { 
      id: user.id,
      github_id: user.github_id,
      username: user.username,
      avatar_url: user.avatar_url,
      display_name: user.display_name
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_DURATION }
  );
};

export const verifyAccessToken = (token: string): User | null => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    return {
      id: decoded.id,
      github_id: decoded.github_id,
      username: decoded.username,
      avatar_url: decoded.avatar_url || '',
      display_name: decoded.display_name || ''
    };
  } catch (error) {
    return null;
  }
};
