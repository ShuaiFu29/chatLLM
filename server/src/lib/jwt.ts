import jwt from 'jsonwebtoken';
import { User } from '../types';
import { serverEnv } from './env';
import { normalizeGithubId } from './githubId';

const JWT_SECRET = serverEnv.JWT_SECRET;

const ACCESS_TOKEN_DURATION_SECONDS = 15 * 60;

type AccessTokenPayload = {
  id: string;
  github_id: string | null;
  username: string;
  avatar_url?: string;
  display_name?: string;
};

const isAccessTokenPayload = (payload: string | jwt.JwtPayload): payload is jwt.JwtPayload & AccessTokenPayload => {
  if (typeof payload === 'string') return false;

  let githubIdIsValid = payload.github_id === null;
  if (typeof payload.github_id === 'string') {
    try {
      githubIdIsValid = normalizeGithubId(payload.github_id) === payload.github_id;
    } catch {
      githubIdIsValid = false;
    }
  }

  return (
    typeof payload.id === 'string' &&
    githubIdIsValid &&
    typeof payload.username === 'string' &&
    (payload.avatar_url === undefined || typeof payload.avatar_url === 'string') &&
    (payload.display_name === undefined || typeof payload.display_name === 'string')
  );
};

export const generateAccessToken = (
  user: User,
  maxLifetimeSeconds = ACCESS_TOKEN_DURATION_SECONDS,
) => {
  if (!Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds <= 0) {
    throw new RangeError('Access token lifetime must be a positive safe integer');
  }
  const expiresIn = Math.min(ACCESS_TOKEN_DURATION_SECONDS, maxLifetimeSeconds);
  const githubId = user.github_id === null ? null : normalizeGithubId(user.github_id);
  return jwt.sign(
    { 
      id: user.id,
      github_id: githubId,
      username: user.username,
      avatar_url: user.avatar_url,
      display_name: user.display_name
    },
    JWT_SECRET,
    { expiresIn }
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
  } catch {
    return null;
  }
};
