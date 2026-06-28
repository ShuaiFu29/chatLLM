import jwt from 'jsonwebtoken';
import { User } from '../types';
import { serverEnv } from './env';

const JWT_SECRET = serverEnv.JWT_SECRET;

// Access Token Duration (15 minutes)
const ACCESS_TOKEN_DURATION = '15m';

type AccessTokenPayload = {
  id: string;
  github_id: number;
  username: string;
  avatar_url?: string;
  display_name?: string;
};

const isAccessTokenPayload = (payload: string | jwt.JwtPayload): payload is jwt.JwtPayload & AccessTokenPayload => {
  if (typeof payload === 'string') return false;

  return (
    typeof payload.id === 'string' &&
    typeof payload.github_id === 'number' &&
    typeof payload.username === 'string' &&
    (payload.avatar_url === undefined || typeof payload.avatar_url === 'string') &&
    (payload.display_name === undefined || typeof payload.display_name === 'string')
  );
};

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
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!isAccessTokenPayload(decoded)) return null;

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
