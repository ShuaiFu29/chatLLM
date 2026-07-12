import { Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { serverEnv } from '../lib/env';
import { generateAccessToken } from '../lib/jwt';
import { cleanupRagFileVectors } from '../lib/ragClient';
import { deleteObject } from '../lib/storage';
import { createSession, deleteSession, deleteSessionsByUser, rotateSession } from '../repositories/sessions';
import { createUser, deleteUser, findUserByGithubId, findUserById, updateUser } from '../repositories/users';
import { listFilesForUserCleanup } from '../repositories/files';

const REFRESH_TOKEN_DURATION = 7 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_DURATION = 15 * 60 * 1000;
const generateRefreshToken = () => crypto.randomBytes(32).toString('base64url');

const stringifyError = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;
    return `AxiosError${status ? `(${status})` : ''}: ${error.message}${data ? ` | ${JSON.stringify(data)}` : ''}`;
  }

  if (error instanceof Error) {
    const cause: any = (error as any).cause;
    if (cause instanceof Error) {
      return `${error.name}: ${error.message} (cause: ${cause.name}: ${cause.message})`;
    }
    if (cause && typeof cause === 'object') {
      const code = (cause as any).code;
      const msg = (cause as any).message;
      if (code || msg) {
        return `${error.name}: ${error.message} (cause: ${code ? String(code) : 'unknown'}${msg ? `: ${String(msg)}` : ''})`;
      }
    }
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === 'string') return error;

  if (error && typeof error === 'object') {
    const maybeMessage = (error as any).message;
    if (typeof maybeMessage === 'string') return maybeMessage;

    try {
      return JSON.stringify(error);
    } catch {
      return '[Unserializable error object]';
    }
  }

  return String(error);
};

let proxyAgent: ProxyAgent | undefined;
const getDispatcher = () => {
  const proxy = serverEnv.HTTPS_PROXY || serverEnv.HTTP_PROXY;
  if (!proxy) return undefined;
  proxyAgent = proxyAgent || new ProxyAgent(proxy);
  return proxyAgent;
};

const fetchJson = async (url: string, init: any) => {
  const resp = await undiciFetch(url, {
    ...init,
    dispatcher: getDispatcher(),
  });

  const text = await resp.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;

  if (!resp.ok) {
    const details = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`HTTP ${resp.status}: ${details}`);
  }

  return data;
};

const setAuthCookies = (res: Response, accessToken: string, refreshToken: string) => {
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ACCESS_TOKEN_DURATION,
  });

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_DURATION,
  });
};

const clearAuthCookies = (res: Response) => {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/auth' });
  res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
};

export const githubLogin = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('github_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    client_id: serverEnv.GITHUB_CLIENT_ID || '',
    redirect_uri: `${serverEnv.BACKEND_URL}/api/auth/github/callback`,
    state,
    scope: 'read:user',
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
};

export const githubCallback = async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const storedState = req.cookies.github_oauth_state;

  if (!code) {
    res.status(400).json({ error: 'Missing code' });
    return;
  }

  if (!state || !storedState || state !== storedState) {
    res.status(403).json({ error: 'Invalid state' });
    return;
  }

  res.clearCookie('github_oauth_state', { path: '/api/auth' });

  try {
    const tokenBody = new URLSearchParams({
      client_id: serverEnv.GITHUB_CLIENT_ID || '',
      client_secret: serverEnv.GITHUB_CLIENT_SECRET || '',
      code,
    });

    const tokenResponse: any = await fetchJson('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenBody.toString(),
    });

    const { access_token } = tokenResponse || {};
    if (!access_token) {
      res.status(400).json({ error: 'Failed to get access token' });
      return;
    }

    const ghUser: any = await fetchJson('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${access_token}`,
        'User-Agent': 'chatLLM-server',
      },
    });

    let user = await findUserByGithubId(Number(ghUser.id));

    if (!user) {
      user = await createUser({
        github_id: Number(ghUser.id),
        username: ghUser.login,
        avatar_url: ghUser.avatar_url,
        display_name: ghUser.name || ghUser.login,
      });
    }

    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DURATION).toISOString();
    await createSession(refreshToken, user.id, expiresAt);

    const jwtAccessToken = generateAccessToken(user);
    setAuthCookies(res, jwtAccessToken, refreshToken);

    res.redirect(`${serverEnv.FRONTEND_URL}?login=success`);
  } catch (error) {
    const errorMessage = stringifyError(error);
    console.error('[Auth] GitHub callback failed:', error);
    res.status(500).json({ error: 'Authentication failed', details: errorMessage });
  }
};

export const refreshToken = async (req: Request, res: Response) => {
  const oldRefreshToken = req.cookies.refresh_token;

  if (!oldRefreshToken) {
    return res.status(401).json({ error: 'No refresh token provided' });
  }

  try {
    const newRefreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DURATION).toISOString();
    const session = await rotateSession(oldRefreshToken, newRefreshToken, expiresAt);

    if (!session) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const newAccessToken = generateAccessToken(session.user);
    setAuthCookies(res, newAccessToken, newRefreshToken);

    res.json({ success: true });
  } catch (error) {
    console.error('Refresh Token Error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
};

export const getMe = async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = await findUserById(req.user.id);

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: User not found' });
  }

  res.json({ user });
};

export const updateProfile = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { display_name, avatar_url, settings } = req.body;

  const user = await updateUser(req.user.id, {
    display_name,
    avatar_url,
    settings,
  });

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ user });
};

export const cleanupUserExternalArtifacts = async (
  files: Array<{ id: string; object_key?: string | null }>,
  avatarObjectKey?: string | null
) => {
  try {
    for (const file of files) {
      await cleanupRagFileVectors(file.id);
      if (file.object_key) {
        await deleteObject(file.object_key);
      }
    }

    if (avatarObjectKey) {
      await deleteObject(avatarObjectKey);
    }
  } catch (error) {
    throw new Error(`Failed to cleanup external artifacts: ${stringifyError(error)}`);
  }
};

export const deleteAccount = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userId = req.user.id;
    const user = await findUserById(userId);
    const files = await listFilesForUserCleanup(userId);

    await cleanupUserExternalArtifacts(files, user?.avatar_object_key);

    await deleteSessionsByUser(userId);
    await deleteUser(userId);

    clearAuthCookies(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
};

export const logout = async (req: Request, res: Response) => {
  const refreshToken = req.cookies.refresh_token;

  if (refreshToken) {
    await deleteSession(refreshToken);
  }

  clearAuthCookies(res);
  res.json({ message: 'Logged out', github_logout_url: 'https://github.com/logout' });
};
