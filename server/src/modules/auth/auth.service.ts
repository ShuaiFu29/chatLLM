import crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import {
  HttpResponse,
  ResponseCookie,
  httpResponse,
} from '../../common/http/http-response';
import { serverEnv } from '../../lib/env';
import { generateAccessToken } from '../../lib/jwt';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from '../../lib/password';
import { toSafeError } from '../../lib/safeError';
import { enqueueAccountCleanup } from '../../repositories/cleanupJobs';
import { createSession, deleteSession, rotateSession } from '../../repositories/sessions';
import {
  createLocalUser,
  createUser,
  EmailAlreadyRegisteredError,
  findUserByGithubId,
  findUserById,
  findUserCredentialsByEmail,
  updateUser,
} from '../../repositories/users';
import { artifactCleanupQueue } from '../../services/cleanupQueue';
import { User } from '../../types';

const REMEMBERED_SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;
const BROWSER_SESSION_DURATION = 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_DURATION = 15 * 60 * 1000;
const generateRefreshToken = () => crypto.randomBytes(32).toString('base64url');

export type AuthCookies = Readonly<Record<string, string | undefined>>;

export interface UpdateProfileInput {
  display_name?: string;
  avatar_url?: string;
  settings?: Record<string, unknown>;
}

export interface GithubCallbackInput {
  code?: string;
  state?: string;
  cookies: AuthCookies;
  requestId?: string;
}

export interface LocalLoginInput {
  email: string;
  password: string;
  rememberMe: boolean;
}

export interface LocalRegisterInput extends LocalLoginInput {
  displayName: string;
}

let proxyAgent: ProxyAgent | undefined;
const getDispatcher = () => {
  const proxy = serverEnv.HTTPS_PROXY || serverEnv.HTTP_PROXY;
  if (!proxy) return undefined;
  proxyAgent = proxyAgent || new ProxyAgent(proxy);
  return proxyAgent;
};

const fetchJson = async (url: string, init: any) => {
  const response = await undiciFetch(url, {
    ...init,
    dispatcher: getDispatcher(),
  });
  const text = await response.text();
  const data = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })() : null;

  if (!response.ok) {
    const details = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`HTTP ${response.status}: ${details}`);
  }

  return data;
};

const cookieLifetime = (durationMs: number) => ({
  maxAge: Math.floor(durationMs / 1000),
  expires: new Date(Date.now() + durationMs),
});

const persistentCookieLifetime = (rememberMe: boolean, durationMs: number) => (
  rememberMe ? cookieLifetime(durationMs) : {}
);

const persistentRefreshCookieLifetime = (
  rememberMe: boolean,
  expiresAt?: string,
) => {
  if (!rememberMe) return {};
  if (!expiresAt) return cookieLifetime(REMEMBERED_SESSION_DURATION);

  const expires = new Date(expiresAt);
  return {
    expires,
    maxAge: Math.max(Math.floor((expires.getTime() - Date.now()) / 1000), 1),
  };
};

const setAuthCookies = (
  accessToken: string,
  refreshToken: string,
  rememberMe: boolean,
  refreshExpiresAt?: string,
): ResponseCookie[] => [
  {
    action: 'set',
    name: 'access_token',
    value: accessToken,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      ...persistentCookieLifetime(rememberMe, ACCESS_TOKEN_DURATION),
    },
  },
  {
    action: 'set',
    name: 'refresh_token',
    value: refreshToken,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth',
      ...persistentRefreshCookieLifetime(rememberMe, refreshExpiresAt),
    },
  },
];

const clearAuthCookies = (): ResponseCookie[] => [
  { action: 'clear', name: 'access_token', options: { path: '/' } },
  { action: 'clear', name: 'refresh_token', options: { path: '/api/auth' } },
  { action: 'clear', name: 'refresh_token', options: { path: '/api/auth/refresh' } },
];

const clearGithubOauthCookies = (): ResponseCookie[] => [
  {
    action: 'clear',
    name: 'github_oauth_state',
    options: { path: '/api/auth' },
  },
  {
    action: 'clear',
    name: 'github_oauth_remember',
    options: { path: '/api/auth' },
  },
];

const getSessionExpiries = () => ({
  remembered: new Date(Date.now() + REMEMBERED_SESSION_DURATION).toISOString(),
  browserSession: new Date(Date.now() + BROWSER_SESSION_DURATION).toISOString(),
});

const createAuthenticatedSession = async (user: User, rememberMe: boolean) => {
  const refreshToken = generateRefreshToken();
  const expiries = getSessionExpiries();
  await createSession(
    refreshToken,
    user.id,
    rememberMe ? expiries.remembered : expiries.browserSession,
    rememberMe,
  );
  const accessToken = generateAccessToken(user);
  return setAuthCookies(
    accessToken,
    refreshToken,
    rememberMe,
    rememberMe ? expiries.remembered : undefined,
  );
};

const redirectResponse = (
  url: string,
  cookies: ResponseCookie[],
): HttpResponse<undefined> => httpResponse(undefined, {
  statusCode: 302,
  headers: { Location: url },
  cookies,
});

@Injectable()
export class AuthService {
  githubLogin(rememberMe = false) {
    const state = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: serverEnv.GITHUB_CLIENT_ID || '',
      redirect_uri: `${serverEnv.BACKEND_URL}/api/auth/github/callback`,
      state,
      scope: 'read:user',
    });

    return redirectResponse(
      `https://github.com/login/oauth/authorize?${params.toString()}`,
      [
        {
          action: 'set',
          name: 'github_oauth_state',
          value: state,
          options: {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/api/auth',
            ...cookieLifetime(10 * 60 * 1000),
          },
        },
        {
          action: 'set',
          name: 'github_oauth_remember',
          value: rememberMe ? '1' : '0',
          options: {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/api/auth',
            ...cookieLifetime(10 * 60 * 1000),
          },
        },
      ],
    );
  }

  async register(input: LocalRegisterInput, requestId?: string) {
    try {
      const passwordHash = await hashPassword(input.password);
      const user = await createLocalUser({
        email: input.email,
        passwordHash,
        displayName: input.displayName,
      });
      const cookies = await createAuthenticatedSession(user, input.rememberMe);
      return httpResponse({ user }, { statusCode: 201, cookies });
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        return httpResponse(
          { error: 'Email is already registered' },
          { statusCode: 409 },
        );
      }
      console.error('[Auth] Registration failed:', toSafeError(error, requestId));
      return httpResponse({ error: 'Registration failed' }, { statusCode: 500 });
    }
  }

  async login(input: LocalLoginInput, requestId?: string) {
    try {
      const credentials = await findUserCredentialsByEmail(input.email);
      const passwordMatches = await verifyPassword(
        input.password,
        credentials?.passwordHash || DUMMY_PASSWORD_HASH,
      );
      if (
        !credentials
        || !passwordMatches
        || credentials.user.deletion_status !== 'active'
      ) {
        return httpResponse(
          { error: 'Invalid email or password' },
          { statusCode: 401 },
        );
      }

      const cookies = await createAuthenticatedSession(
        credentials.user,
        input.rememberMe,
      );
      return httpResponse({ user: credentials.user }, { cookies });
    } catch (error) {
      console.error('[Auth] Login failed:', toSafeError(error, requestId));
      return httpResponse({ error: 'Authentication failed' }, { statusCode: 500 });
    }
  }

  async githubCallback(input: GithubCallbackInput) {
    const { code, state, cookies, requestId } = input;
    const storedState = cookies.github_oauth_state;

    if (!code) {
      return httpResponse(
        { error: 'Missing code' },
        { statusCode: 400, cookies: clearGithubOauthCookies() },
      );
    }
    if (!state || !storedState || state !== storedState) {
      return httpResponse(
        { error: 'Invalid state' },
        { statusCode: 403, cookies: clearGithubOauthCookies() },
      );
    }

    const oauthCookies = clearGithubOauthCookies();
    const rememberMe = cookies.github_oauth_remember === '1';
    try {
      const tokenBody = new URLSearchParams({
        client_id: serverEnv.GITHUB_CLIENT_ID || '',
        client_secret: serverEnv.GITHUB_CLIENT_SECRET || '',
        code,
      });
      const tokenResponse: any = await fetchJson(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: tokenBody.toString(),
        },
      );
      const { access_token: githubAccessToken } = tokenResponse || {};
      if (!githubAccessToken) {
        return httpResponse(
          { error: 'Failed to get access token' },
          { statusCode: 400, cookies: oauthCookies },
        );
      }

      const githubUser: any = await fetchJson('https://api.github.com/user', {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${githubAccessToken}`,
          'User-Agent': 'chatLLM-server',
        },
      });
      let user = await findUserByGithubId(Number(githubUser.id));
      if (user?.deletion_status === 'pending') {
        return httpResponse(
          { error: 'Account deletion is in progress' },
          { statusCode: 409, cookies: oauthCookies },
        );
      }
      if (!user) {
        user = await createUser({
          github_id: Number(githubUser.id),
          username: githubUser.login,
          avatar_url: githubUser.avatar_url,
          display_name: githubUser.name || githubUser.login,
        });
      }

      const authCookies = await createAuthenticatedSession(user, rememberMe);
      return redirectResponse(
        `${serverEnv.FRONTEND_URL}?login=success`,
        [...oauthCookies, ...authCookies],
      );
    } catch (error) {
      console.error('[Auth] GitHub callback failed:', toSafeError(error, requestId));
      return httpResponse(
        { error: 'Authentication failed' },
        { statusCode: 500, cookies: oauthCookies },
      );
    }
  }

  async refresh(cookies: AuthCookies, requestId?: string) {
    const oldRefreshToken = cookies.refresh_token;
    if (!oldRefreshToken) {
      return httpResponse({ error: 'No refresh token provided' }, { statusCode: 401 });
    }

    try {
      const newRefreshToken = generateRefreshToken();
      const session = await rotateSession(
        oldRefreshToken,
        newRefreshToken,
      );
      if (!session) {
        return httpResponse(
          { error: 'Invalid or expired refresh token' },
          { statusCode: 401, cookies: clearAuthCookies() },
        );
      }

      const newAccessToken = generateAccessToken(session.user);
      return httpResponse(
        { success: true },
        {
          cookies: setAuthCookies(
            newAccessToken,
            newRefreshToken,
            session.remember_me,
            session.expires_at,
          ),
        },
      );
    } catch (error) {
      console.error('Refresh Token Error:', toSafeError(error, requestId));
      return httpResponse({ error: 'Failed to refresh token' }, { statusCode: 500 });
    }
  }

  async getMe(user: User) {
    const currentUser = await findUserById(user.id);
    if (!currentUser) {
      return httpResponse({ error: 'Unauthorized: User not found' }, { statusCode: 401 });
    }
    return { user: currentUser };
  }

  async updateProfile(user: User, input: UpdateProfileInput) {
    const updatedUser = await updateUser(user.id, input);
    if (!updatedUser) {
      return httpResponse({ error: 'User not found' }, { statusCode: 404 });
    }
    return { user: updatedUser };
  }

  async deleteAccount(user: User, requestId?: string) {
    let cleanupQueued = false;
    try {
      const cleanup = await enqueueAccountCleanup(user.id);
      if (!cleanup) {
        return httpResponse({ error: 'User not found' }, { statusCode: 404 });
      }
      cleanupQueued = true;
      artifactCleanupQueue.trigger();
      return httpResponse({
        status: 'deleting',
        cleanup_job_id: cleanup.job.id,
        child_jobs: cleanup.childCount,
      }, {
        statusCode: 202,
        cookies: clearAuthCookies(),
      });
    } catch (error) {
      console.error('Delete account error:', toSafeError(error, requestId));
      return httpResponse(
        { error: 'Failed to delete account' },
        {
          statusCode: 500,
          ...(cleanupQueued ? { cookies: clearAuthCookies() } : {}),
        },
      );
    }
  }

  async logout(cookies: AuthCookies) {
    const refreshToken = cookies.refresh_token;
    if (refreshToken) {
      await deleteSession(refreshToken);
    }
    return httpResponse(
      { message: 'Logged out', github_logout_url: 'https://github.com/logout' },
      { cookies: clearAuthCookies() },
    );
  }
}
