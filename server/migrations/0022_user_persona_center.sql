create table if not exists user_personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  summary text not null default '',
  role_label text not null default '',
  goals text[] not null default '{}'::text[],
  preferences text[] not null default '{}'::text[],
  avoided_topics text[] not null default '{}'::text[],
  memory_enabled boolean not null default true,
  updated_by_user_at timestamptz,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists user_persona_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  category text not null,
  label text not null,
  detail text not null,
  confidence double precision not null default 0,
  evidence_count integer not null default 0,
  evidence_message_ids uuid[] not null default '{}'::uuid[],
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_persona_observations_status_check check (status in ('active', 'accepted', 'hidden', 'rejected'))
);

create unique index if not exists user_persona_observations_user_label_idx
  on user_persona_observations(user_id, category, label);
create index if not exists user_persona_observations_user_status_idx
  on user_persona_observations(user_id, status, confidence desc);

create table if not exists user_interest_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  topic text not null,
  score double precision not null default 0,
  trend text not null default 'steady',
  evidence_count integer not null default 0,
  evidence_message_ids uuid[] not null default '{}'::uuid[],
  last_seen_at timestamptz,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_interest_topics_status_check check (status in ('active', 'accepted', 'hidden', 'rejected')),
  constraint user_interest_topics_trend_check check (trend in ('rising', 'steady', 'cooling'))
);

create unique index if not exists user_interest_topics_user_topic_idx
  on user_interest_topics(user_id, topic);
create index if not exists user_interest_topics_user_score_idx
  on user_interest_topics(user_id, status, score desc);

create table if not exists user_question_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  topic text not null,
  question text not null,
  reason text not null default '',
  confidence double precision not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_question_suggestions_status_check check (status in ('active', 'hidden', 'used'))
);

create unique index if not exists user_question_suggestions_user_question_idx
  on user_question_suggestions(user_id, question);
create index if not exists user_question_suggestions_user_status_idx
  on user_question_suggestions(user_id, status, confidence desc);

create table if not exists user_persona_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_type text not null,
  target_type text not null,
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_persona_audit_events_user_created_idx
  on user_persona_audit_events(user_id, created_at desc);
