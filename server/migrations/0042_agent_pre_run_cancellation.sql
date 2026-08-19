-- Preserve an explicit stop request that arrives after the chat user message
-- is stored but before its Agent run row has been created. The intent is tied
-- to that exact message so it cannot cancel the user's next prompt.

create table if not exists agent_run_cancel_intents (
  user_message_id uuid primary key references messages(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint agent_run_cancel_intents_expiry_check check (expires_at > requested_at)
);

create index if not exists agent_run_cancel_intents_user_conversation_idx
  on agent_run_cancel_intents (user_id, conversation_id, requested_at desc);

create index if not exists agent_run_cancel_intents_expires_idx
  on agent_run_cancel_intents (expires_at);
