import crypto from 'crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { serverEnv } from '../lib/env';
import { generateAccessToken } from '../lib/jwt';
import { createSession, deleteSession, rotateSession } from '../repositories/sessions';
import { createUser, findUserByGithubId, findUserById, updateUser } from '../repositories/users';
import { enqueueAccountCleanup } from '../repositories/cleanupJobs';
import { toSafeError } from '../lib/safeError';
import { artifactCleanupQueue } from '../services/cleanupQueue';
import { AppReply, AppRequest } from '../common/http/app-request';

const REFRESH_TOKEN_DURATION = 7 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_DURATION = 15 * 60 * 1000;
const generateRefreshToken = () => crypto.randomBytes(32).toString('base64url');

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

const cookieLifetime = (durationMs: number) => ({
  maxAge: Math.floor(durationMs / 1000),
  expires: new Date(Date.now() + durationMs),
});

const setAuthCookies = (reply: AppReply, accessToken: string, refreshToken: string) => {
  reply.setCookie('access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...cookieLifetime(ACCESS_TOKEN_DURATION),
  });

  reply.setCookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    ...cookieLifetime(REFRESH_TOKEN_DURATION),
  });
};

const clearAuthCookies = (reply: AppReply) => {
  reply.clearCookie('access_token', { path: '/' });
  reply.clearCookie('refresh_token', { path: '/api/auth' });
  reply.clearCookie('refresh_token', { path: '/api/auth/refresh' });
};

export const githubLogin = (_req: AppRequest, reply: AppReply) => {
  const state = crypto.randomBytes(16).toString('hex');
  reply.setCookie('github_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    ...cookieLifetime(10 * 60 * 1000),
  });

  const params = new URLSearchParams({
    client_id: serverEnv.GITHUB_CLIENT_ID || '',
    redirect_uri: `${serverEnv.BACKEND_URL}/api/auth/github/callback`,
    state,
    scope: 'read:user',
  });

  reply.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
};

export const githubCallback = async (req: AppRequest, reply: AppReply) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const storedState = req.cookies.github_oauth_state;

  if (!code) {
    reply.code(400).send({ error: 'Missing code' });
    return;
  }

  if (!state || !storedState || state !== storedState) {
    reply.code(403).send({ error: 'Invalid state' });
    return;
  }

  reply.clearCookie('github_oauth_state', { path: '/api/auth' });

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
      reply.code(400).send({ error: 'Failed to get access token' });
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

    if (user?.deletion_status === 'pending') {
      reply.code(409).send({ error: 'Account deletion is in progress' });
      return;
    }

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
    setAuthCookies(reply, jwtAccessToken, refreshToken);

    reply.redirect(`${serverEnv.FRONTEND_URL}?login=success`);
  } catch (error) {
    console.error('[Auth] GitHub callback failed:', toSafeError(error, req.requestId));
    reply.code(500).send({ error: 'Authentication failed' });
  }
};

export const refreshToken = async (req: AppRequest, reply: AppReply) => {
  const oldRefreshToken = req.cookies.refresh_token;

  if (!oldRefreshToken) {
    return reply.code(401).send({ error: 'No refresh token provided' });
  }

  try {
    const newRefreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DURATION).toISOString();
    const session = await rotateSession(oldRefreshToken, newRefreshToken, expiresAt);

    if (!session) {
      clearAuthCookies(reply);
      return reply.code(401).send({ error: 'Invalid or expired refresh token' });
    }

    const newAccessToken = generateAccessToken(session.user);
    setAuthCookies(reply, newAccessToken, newRefreshToken);

    reply.send({ success: true });
  } catch (error) {
    console.error('Refresh Token Error:', toSafeError(error, req.requestId));
    reply.code(500).send({ error: 'Failed to refresh token' });
  }
};

export const getMe = async (req: AppRequest, reply: AppReply) => {
  if (!req.user) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const user = await findUserById(req.user.id);

  if (!user) {
    return reply.code(401).send({ error: 'Unauthorized: User not found' });
  }

  reply.send({ user });
};

export const updateProfile = async (req: AppRequest, reply: AppReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Unauthorized' });

  const { display_name, avatar_url, settings } = req.body;

  const user = await updateUser(req.user.id, {
    display_name,
    avatar_url,
    settings,
  });

  if (!user) {
    return reply.code(404).send({ error: 'User not found' });
  }

  reply.send({ user });
};

export const deleteAccount = async (req: AppRequest, reply: AppReply) => {
  if (!req.user) return reply.code(401).send({ error: 'Unauthorized' });

  try {
    const userId = req.user.id;
    const cleanup = await enqueueAccountCleanup(userId);
    if (!cleanup) return reply.code(404).send({ error: 'User not found' });
    clearAuthCookies(reply);
    artifactCleanupQueue.trigger();
    reply.code(202).send({
      status: 'deleting',
      cleanup_job_id: cleanup.job.id,
      child_jobs: cleanup.childCount,
    });
  } catch (error) {
    console.error('Delete account error:', toSafeError(error, req.requestId));
    reply.code(500).send({ error: 'Failed to delete account' });
  }
};

export const logout = async (req: AppRequest, reply: AppReply) => {
  const refreshToken = req.cookies.refresh_token;

  if (refreshToken) {
    await deleteSession(refreshToken);
  }

  clearAuthCookies(reply);
  reply.send({ message: 'Logged out', github_logout_url: 'https://github.com/logout' });
};
