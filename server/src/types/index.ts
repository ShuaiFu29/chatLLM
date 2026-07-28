export interface UserSettings {
  temperature?: number;
  model?: string;
  system_prompt?: string;
}

export interface User {
  id: string; // PostgreSQL UUID string
  github_id: string | null;
  username: string;
  avatar_url: string;
  display_name?: string;
  deletion_status?: 'active' | 'pending';
  created_at?: string;
  settings?: UserSettings;
}

export interface Session {
  id: string;
  user_id: string; // PostgreSQL UUID string
  created_at: string;
  expires_at: string;
}
