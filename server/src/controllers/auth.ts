import { Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { supabase } from '../lib/supabase';
import { generateAccessToken } from '../lib/jwt';

// Configuration
const REFRESH_TOKEN_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCESS_TOKEN_DURATION = 15 * 60 * 1000; // 15 minutes

export const githubLogin = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('github_oauth_state', state, { httpOnly: true, maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/auth/github/callback`,
    state,
    scope: 'read:user'
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
};

export const githubCallback = async (req: Request, res: Response) => {
  const { code, state } = req.query;
  const storedState = req.cookies.github_oauth_state;

  if (!state || state !== storedState) {
    res.status(403).json({ error: 'Invalid state' });
    return;
  }

  res.clearCookie('github_oauth_state');

  try {
    // 1. Exchange code for access token
    // Note: removed explicit proxy: false to allow system proxy (e.g. from env vars)
    const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }, {
      headers: { Accept: 'application/json' }
    });

    const { access_token } = tokenResponse.data;
    if (!access_token) {
      res.status(400).json({ error: 'Failed to get access token' });
      return;
    }

    // 2. Get GitHub user info
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const ghUser = userResponse.data;

    // 3. Find or Create User in Supabase
    let { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('github_id', ghUser.id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    if (!user) {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          github_id: ghUser.id,
          username: ghUser.login,
          avatar_url: ghUser.avatar_url,
          display_name: ghUser.name || ghUser.login,
        })
        .select()
        .single();

      if (createError) {
        throw createError;
      }
      user = newUser;
    }

    // 4. Create Refresh Token (Session)
    const refreshToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DURATION).toISOString();

    const { error: sessionError } = await supabase
      .from('sessions')
      .insert({
        id: refreshToken, // Use UUID as refresh token
        user_id: user.id,
        expires_at: expiresAt
      });

    if (sessionError) {
      throw sessionError;
    }

    // 5. Generate Access Token (JWT)
    if (!user.id) {
      throw new Error('User ID is missing');
    }
    const jwtAccessToken = generateAccessToken(user);

    // 6. Set Cookies
    // Access Token - Short lived
    res.cookie('access_token', jwtAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ACCESS_TOKEN_DURATION
    });

    // Refresh Token - Long lived
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth/refresh', // Restrict path
      maxAge: REFRESH_TOKEN_DURATION
    });

    res.redirect(`${process.env.FRONTEND_URL}?login=success`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Authentication failed', details: errorMessage });
  }
};

export const refreshToken = async (req: Request, res: Response) => {
  const oldRefreshToken = req.cookies.refresh_token;

  if (!oldRefreshToken) {
    return res.status(401).json({ error: 'No refresh token provided' });
  }

  try {
    // 1. Verify Refresh Token in DB
    const { data: session, error } = await supabase
      .from('sessions')
      .select('*, user:users(*)')
      .eq('id', oldRefreshToken)
      .single();

    if (error || !session) {
      res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
      res.clearCookie('access_token');
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Check expiration
    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('sessions').delete().eq('id', oldRefreshToken);
      res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
      res.clearCookie('access_token');
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // 2. Rotate Token: Delete old session, create new one
    await supabase.from('sessions').delete().eq('id', oldRefreshToken);

    const newRefreshToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DURATION).toISOString();

    const { error: createError } = await supabase
      .from('sessions')
      .insert({
        id: newRefreshToken,
        user_id: session.user.id,
        expires_at: expiresAt
      });

    if (createError) throw createError;

    // 3. Generate new Access Token
    const newAccessToken = generateAccessToken(session.user);

    // 4. Set Cookies
    res.cookie('access_token', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ACCESS_TOKEN_DURATION
    });

    res.cookie('refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth/refresh',
      maxAge: REFRESH_TOKEN_DURATION
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Refresh Token Error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
};

export const getMe = async (req: Request, res: Response) => {
  // Middleware should have already populated req.user from JWT
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fetch latest user data from DB to ensure settings are up-to-date
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', req.user.id)
    .single();

  if (error || !user) {
    console.error('Error fetching user details:', error);
    // Fallback to JWT user if DB fetch fails (though this shouldn't happen)
    return res.json({ user: req.user });
  }

  res.json({ user });
};

export const updateProfile = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { display_name, avatar_url, settings } = req.body;

  const updates: any = {};
  if (display_name !== undefined) updates.display_name = display_name;
  if (avatar_url !== undefined) updates.avatar_url = avatar_url;
  if (settings !== undefined) updates.settings = settings;

  const { data: user, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) {
    console.error('Error updating profile:', error);
    return res.status(500).json({ error: 'Failed to update profile' });
  }

  res.json({ user });
};

export const deleteAccount = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // Delete all user data
  // Note: If you have foreign key constraints with ON DELETE CASCADE, deleting the user might be enough.
  // Otherwise, you need to manually delete related data.
  // Here we assume manual deletion for safety or strict constraints.

  try {
    const userId = req.user.id;

    // 1. Delete sessions
    await supabase.from('sessions').delete().eq('user_id', userId);

    // 2. Delete messages (via conversation cascade or manual)
    // If conversations delete cascades to messages, we just need to delete conversations.
    // Let's delete conversations.
    await supabase.from('conversations').delete().eq('user_id', userId);

    // 3. Delete documents
    await supabase.from('documents').delete().contains('metadata', { user_id: userId });

    // 4. Delete user
    const { error } = await supabase.from('users').delete().eq('id', userId);

    if (error) {
      console.error('Error deleting user:', error);
      throw error;
    }

    res.clearCookie('access_token');
    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
    res.json({ success: true });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
};

export const logout = async (req: Request, res: Response) => {
  const refreshToken = req.cookies.refresh_token;

  if (refreshToken) {
    await supabase.from('sessions').delete().eq('id', refreshToken);
  }

  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
  res.json({ message: 'Logged out', github_logout_url: 'https://github.com/logout' });
};
