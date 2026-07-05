create table if not exists rag_runs (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  assistant_message_id uuid references messages(id) on delete set null,
  mode text not null default 'agentic',
  query text not null,
  planned_queries jsonb not null default '[]'::jsonb,
  trace_steps jsonb not null default '[]'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  retrieved_sources jsonb not null default '[]'::jsonb,
  status text not null default 'success',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rag_runs_status_check check (status in ('success', 'partial', 'failed'))
);

alter table messages
  add column if not exists rag_run_id text references rag_runs(id) on delete set null;

create index if not exists rag_runs_user_conversation_created_idx
  on rag_runs(user_id, conversation_id, created_at desc);

create index if not exists rag_runs_assistant_message_idx
  on rag_runs(assistant_message_id);

create index if not exists messages_rag_run_id_idx
  on messages(rag_run_id);
