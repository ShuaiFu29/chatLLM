-- Persistent, bounded conversation summaries for Agent context.
-- The summary is extractive and remains untrusted user-role data. A stable
-- (created_at,id) watermark makes refreshes idempotent and auditable.

create unique index if not exists conversations_id_user_unique_idx
  on conversations(id, user_id);

create table if not exists agent_conversation_summaries (
  conversation_id uuid primary key,
  user_id uuid not null,
  summary text not null default '',
  watermark_message_id uuid,
  watermark_created_at timestamptz,
  included_message_count integer not null default 0,
  candidate_message_count integer not null default 0,
  max_tokens integer not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_conversation_summaries_conversation_user_fkey
    foreign key (conversation_id, user_id)
    references conversations(id, user_id)
    on delete cascade,
  constraint agent_conversation_summaries_shape_check check (
    max_tokens between 32 and 4000
    and revision > 0
    and included_message_count between 0 and 256
    and candidate_message_count >= included_message_count
    and char_length(summary) <= 16000
    and (
      (
        watermark_message_id is null
        and watermark_created_at is null
        and summary = ''
        and included_message_count = 0
        and candidate_message_count = 0
      )
      or (
        watermark_message_id is not null
        and watermark_created_at is not null
        and summary <> ''
        and included_message_count > 0
      )
    )
  )
);

create index if not exists agent_conversation_summaries_user_updated_idx
  on agent_conversation_summaries(user_id, updated_at desc, conversation_id);

create or replace function validate_agent_conversation_summary_watermark()
returns trigger
language plpgsql
as $$
declare
  message_row record;
begin
  if new.watermark_message_id is null then
    new.watermark_created_at := null;
    return new;
  end if;

  select message.conversation_id, message.created_at
  into message_row
  from messages message
  where message.id = new.watermark_message_id;

  if not found then
    raise exception using
      errcode = '23514',
      constraint = 'agent_conversation_summaries_watermark_scope_check',
      message = 'Conversation summary watermark message does not exist';
  end if;

  if message_row.conversation_id <> new.conversation_id then
    raise exception using
      errcode = '23514',
      constraint = 'agent_conversation_summaries_watermark_scope_check',
      message = 'Conversation summary watermark must belong to its conversation';
  end if;
  new.watermark_created_at := message_row.created_at;
  return new;
end;
$$;

drop trigger if exists agent_conversation_summary_watermark_guard
on agent_conversation_summaries;
create trigger agent_conversation_summary_watermark_guard
before insert or update of conversation_id, watermark_message_id, watermark_created_at
on agent_conversation_summaries
for each row
execute function validate_agent_conversation_summary_watermark();

create or replace function invalidate_agent_conversation_summary_for_message()
returns trigger
language plpgsql
as $$
begin
  update agent_conversation_summaries summary_row
  set summary = '',
      watermark_message_id = null,
      watermark_created_at = null,
      included_message_count = 0,
      candidate_message_count = 0,
      revision = summary_row.revision + 1,
      updated_at = now()
  where summary_row.conversation_id = old.conversation_id
    and summary_row.watermark_created_at is not null
    and (old.created_at, old.id)
      <= (summary_row.watermark_created_at, summary_row.watermark_message_id);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function lock_agent_conversation_summary_for_message()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('agent-conversation-summary:' || old.conversation_id::text, 0)
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_conversation_summary_message_delete_lock on messages;
create trigger agent_conversation_summary_message_delete_lock
before delete on messages
for each row
execute function lock_agent_conversation_summary_for_message();

drop trigger if exists agent_conversation_summary_message_update_lock on messages;
create trigger agent_conversation_summary_message_update_lock
before update of content, role on messages
for each row
when (old.content is distinct from new.content or old.role is distinct from new.role)
execute function lock_agent_conversation_summary_for_message();

drop trigger if exists agent_conversation_summary_message_delete_trigger on messages;
create trigger agent_conversation_summary_message_delete_trigger
after delete on messages
for each row
execute function invalidate_agent_conversation_summary_for_message();

drop trigger if exists agent_conversation_summary_message_update_trigger on messages;
create trigger agent_conversation_summary_message_update_trigger
after update of content, role on messages
for each row
when (old.content is distinct from new.content or old.role is distinct from new.role)
execute function invalidate_agent_conversation_summary_for_message();

comment on table agent_conversation_summaries is
  'Bounded extractive Agent conversation context with an exact message watermark; summary text is untrusted data, never system instructions.';
