export interface UserSettings {
  temperature?: number;
  model?: string;
  system_prompt?: string;
}

export interface User {
  id: string; // Supabase uses UUID string, not number
  github_id: number;
  username: string;
  avatar_url: string;
  display_name?: string;
  created_at?: string;
  settings?: UserSettings;
}

export interface Session {
  id: string;
  user_id: string; // Supabase uses UUID string
  created_at: string;
  expires_at: string;
}
