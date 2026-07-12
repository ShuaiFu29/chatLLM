import { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db';
import {
  analyzePersonaSignals,
  mergePersonaProfile,
  PersonaInterestDraft,
  PersonaMessageInput,
  PersonaObservationDraft,
  PersonaProfileDraft,
  PersonaSuggestionDraft,
} from '../lib/personaInsights';

interface PersonaEvidenceMessage {
  id: string;
  content: string;
  created_at: string;
}

export interface UserPersonaRow extends PersonaProfileDraft {
  id: string;
  user_id: string;
  analyzed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserPersonaObservationRow extends PersonaObservationDraft {
  id: string;
  user_id: string;
  status: 'active' | 'accepted' | 'hidden' | 'rejected';
  created_at: string;
  updated_at: string;
  evidence_messages?: PersonaEvidenceMessage[];
}

export interface UserInterestTopicRow extends PersonaInterestDraft {
  id: string;
  user_id: string;
  status: 'active' | 'accepted' | 'hidden' | 'rejected';
  created_at: string;
  updated_at: string;
  evidence_messages?: PersonaEvidenceMessage[];
}

export interface UserQuestionSuggestionRow extends PersonaSuggestionDraft {
  id: string;
  user_id: string;
  status: 'active' | 'hidden' | 'used' | 'rejected';
  created_at: string;
  updated_at: string;
}

export interface PersonaHiddenRecords {
  observations: UserPersonaObservationRow[];
  interests: UserInterestTopicRow[];
  suggestions: UserQuestionSuggestionRow[];
}

export interface PersonaCenter {
  profile: UserPersonaRow;
  observations: UserPersonaObservationRow[];
  interests: UserInterestTopicRow[];
  suggestions: UserQuestionSuggestionRow[];
  hidden: PersonaHiddenRecords;
}

export interface PersonaProfileUpdate {
  summary?: string;
  role_label?: string;
  goals?: string[];
  preferences?: string[];
  avoided_topics?: string[];
  memory_enabled?: boolean;
}

const personaColumns = `
  id,
  user_id,
  summary,
  role_label,
  goals,
  preferences,
  avoided_topics,
  memory_enabled,
  updated_by_user_at,
  analyzed_at,
  created_at,
  updated_at
`;

const observationColumns = `
  id,
  user_id,
  category,
  label,
  detail,
  confidence,
  evidence_count,
  evidence_message_ids,
  status,
  created_at,
  updated_at
`;

const interestColumns = `
  id,
  user_id,
  topic,
  score,
  trend,
  evidence_count,
  evidence_message_ids,
  last_seen_at,
  status,
  created_at,
  updated_at
`;

const suggestionColumns = `
  id,
  user_id,
  topic,
  question,
  reason,
  confidence,
  status,
  created_at,
  updated_at
`;

const uniqueEvidenceIds = (items: Array<{ evidence_message_ids?: string[] }>) => (
  Array.from(new Set(items.flatMap((item) => item.evidence_message_ids || []))).slice(0, 200)
);

const loadEvidenceMessagesForUser = async (userId: string, evidenceIds: string[]) => {
  if (evidenceIds.length === 0) return new Map<string, PersonaEvidenceMessage>();

  const { rows } = await query<PersonaEvidenceMessage>(
    `select m.id, left(m.content, 360) as content, m.created_at
     from messages m
     join conversations c on c.id = m.conversation_id
     where c.user_id = $1
       and m.id = any($2::uuid[])
       and m.role = 'user'
     order by m.created_at desc`,
    [userId, evidenceIds]
  );

  return new Map(rows.map((row) => [row.id, row]));
};

const attachEvidenceMessages = <T extends { evidence_message_ids?: string[] }>(
  items: T[],
  evidenceById: Map<string, PersonaEvidenceMessage>
) => items.map((item) => ({
  ...item,
  evidence_messages: (item.evidence_message_ids || [])
    .map((id) => evidenceById.get(id))
    .filter((message): message is PersonaEvidenceMessage => Boolean(message)),
}));

export const normalizePersonaProfileUpdate = (body: unknown): PersonaProfileUpdate => {
  const input = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  const update: PersonaProfileUpdate = {};

  if (input.summary !== undefined) update.summary = input.summary as string;

  const roleLabel = input.role_label ?? input.roleLabel;
  if (roleLabel !== undefined) update.role_label = roleLabel as string;

  if (input.goals !== undefined) update.goals = input.goals as string[];
  if (input.preferences !== undefined) update.preferences = input.preferences as string[];

  const avoidedTopics = input.avoided_topics ?? input.avoidedTopics;
  if (avoidedTopics !== undefined) update.avoided_topics = avoidedTopics as string[];

  const memoryEnabled = input.memory_enabled ?? input.memoryEnabled;
  if (memoryEnabled !== undefined) update.memory_enabled = memoryEnabled as boolean;

  return update;
};

export const listRecentUserMessagesForPersona = async (userId: string, limit = 100) => {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const { rows } = await query<PersonaMessageInput>(
    `select m.id, m.content, m.created_at
     from messages m
     join conversations c on c.id = m.conversation_id
     where c.user_id = $1
       and m.role = 'user'
     order by m.created_at desc
     limit $2`,
    [userId, boundedLimit]
  );
  return rows;
};

const listRecentUserMessagesForPersonaInTransaction = async (
  client: PoolClient,
  userId: string,
  limit = 100
) => {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const { rows } = await client.query<PersonaMessageInput>(
    `select m.id, m.content, m.created_at
     from messages m
     join conversations c on c.id = m.conversation_id
     where c.user_id = $1
       and m.role = 'user'
     order by m.created_at desc
     limit $2`,
    [userId, boundedLimit]
  );
  return rows;
};

export const ensurePersonaProfileForUser = async (userId: string) => {
  const { rows } = await query<UserPersonaRow>(
    `insert into user_personas (user_id)
     values ($1)
     on conflict (user_id) do update set updated_at = user_personas.updated_at
     returning ${personaColumns}`,
    [userId]
  );
  return rows[0];
};

const ensurePersonaProfileForUserInTransaction = async (
  client: PoolClient,
  userId: string
) => {
  const { rows } = await client.query<UserPersonaRow>(
    `insert into user_personas (user_id)
     values ($1)
     on conflict (user_id) do update set updated_at = user_personas.updated_at
     returning ${personaColumns}`,
    [userId]
  );
  return rows[0];
};

export const getPersonaPromptContextForUser = async (userId: string) => {
  const { rows } = await query<UserPersonaRow>(
    `select ${personaColumns}
     from user_personas
     where user_id = $1`,
    [userId]
  );
  return rows[0] || null;
};

export const getPersonaCenterForUser = async (userId: string): Promise<PersonaCenter> => {
  const profile = await ensurePersonaProfileForUser(userId);
  if (!profile.memory_enabled) {
    return {
      profile,
      observations: [],
      interests: [],
      suggestions: [],
      hidden: {
        observations: [],
        interests: [],
        suggestions: [],
      },
    };
  }

  const [observations, interests, suggestions, hiddenObservations, hiddenInterests, hiddenSuggestions] = await Promise.all([
    query<UserPersonaObservationRow>(
      `select ${observationColumns}
       from user_persona_observations
       where user_id = $1
         and status in ('active', 'accepted')
       order by confidence desc, updated_at desc
       limit 30`,
      [userId]
    ),
    query<UserInterestTopicRow>(
      `select ${interestColumns}
       from user_interest_topics
       where user_id = $1
         and status in ('active', 'accepted')
       order by score desc, updated_at desc
       limit 30`,
      [userId]
    ),
    query<UserQuestionSuggestionRow>(
      `select ${suggestionColumns}
       from user_question_suggestions
       where user_id = $1
         and status = 'active'
       order by confidence desc, updated_at desc
       limit 12`,
      [userId]
    ),
    query<UserPersonaObservationRow>(
      `select ${observationColumns}
       from user_persona_observations
       where user_id = $1
         and status = 'hidden'
       order by updated_at desc
       limit 100`,
      [userId]
    ),
    query<UserInterestTopicRow>(
      `select ${interestColumns}
       from user_interest_topics
       where user_id = $1
         and status = 'hidden'
       order by updated_at desc
       limit 100`,
      [userId]
    ),
    query<UserQuestionSuggestionRow>(
      `select ${suggestionColumns}
       from user_question_suggestions
       where user_id = $1
         and status = 'hidden'
       order by updated_at desc
       limit 100`,
      [userId]
    ),
  ]);

  const evidenceById = await loadEvidenceMessagesForUser(
    userId,
    uniqueEvidenceIds([...observations.rows, ...interests.rows, ...hiddenObservations.rows, ...hiddenInterests.rows])
  );

  return {
    profile,
    observations: attachEvidenceMessages(observations.rows, evidenceById),
    interests: attachEvidenceMessages(interests.rows, evidenceById),
    suggestions: suggestions.rows,
    hidden: {
      observations: attachEvidenceMessages(hiddenObservations.rows, evidenceById),
      interests: attachEvidenceMessages(hiddenInterests.rows, evidenceById),
      suggestions: hiddenSuggestions.rows,
    },
  };
};

export const upsertPersonaProfileForUser = async (
  userId: string,
  profile: PersonaProfileDraft
) => {
  const { rows } = await query<UserPersonaRow>(
    `insert into user_personas (
       user_id,
       summary,
       role_label,
       goals,
       preferences,
       avoided_topics,
       memory_enabled,
       analyzed_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (user_id) do update set
       summary = case when user_personas.updated_by_user_at is null then excluded.summary else user_personas.summary end,
       role_label = case when user_personas.updated_by_user_at is null then excluded.role_label else user_personas.role_label end,
       goals = case when user_personas.updated_by_user_at is null then excluded.goals else user_personas.goals end,
       preferences = case when user_personas.updated_by_user_at is null then excluded.preferences else user_personas.preferences end,
       avoided_topics = case when user_personas.updated_by_user_at is null then excluded.avoided_topics else user_personas.avoided_topics end,
       memory_enabled = user_personas.memory_enabled,
       analyzed_at = now(),
       updated_at = now()
     returning ${personaColumns}`,
    [
      userId,
      profile.summary,
      profile.role_label,
      profile.goals,
      profile.preferences,
      profile.avoided_topics,
      profile.memory_enabled,
    ]
  );
  return rows[0];
};

export const updatePersonaProfileForUser = async (
  userId: string,
  update: PersonaProfileUpdate
) => {
  const current = await ensurePersonaProfileForUser(userId);
  const next = {
    summary: update.summary ?? current.summary,
    role_label: update.role_label ?? current.role_label,
    goals: update.goals ?? current.goals,
    preferences: update.preferences ?? current.preferences,
    avoided_topics: update.avoided_topics ?? current.avoided_topics,
    memory_enabled: update.memory_enabled ?? current.memory_enabled,
  };

  const { rows } = await query<UserPersonaRow>(
    `update user_personas
     set summary = $2,
         role_label = $3,
         goals = $4,
         preferences = $5,
         avoided_topics = $6,
         memory_enabled = $7,
         updated_by_user_at = now(),
         updated_at = now()
     where user_id = $1
     returning ${personaColumns}`,
    [
      userId,
      next.summary,
      next.role_label,
      next.goals,
      next.preferences,
      next.avoided_topics,
      next.memory_enabled,
    ]
  );

  await recordPersonaAuditEvent(userId, 'profile_updated', 'profile', rows[0]?.id, update);
  return rows[0];
};

export const refreshPersonaInsightsForUser = async (userId: string) => {
  await withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`persona-refresh:${userId}`]);

    const currentProfile = await ensurePersonaProfileForUserInTransaction(client, userId);
    if (!currentProfile.memory_enabled) return;

    const recentMessages = await listRecentUserMessagesForPersonaInTransaction(client, userId, 100);
    const generated = analyzePersonaSignals(recentMessages);
    const mergedProfile = mergePersonaProfile(currentProfile, generated.profile);

    await client.query(
      `insert into user_personas (
         user_id,
         summary,
         role_label,
         goals,
         preferences,
         avoided_topics,
         memory_enabled,
         analyzed_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (user_id) do update set
         summary = case when user_personas.updated_by_user_at is null then excluded.summary else user_personas.summary end,
         role_label = case when user_personas.updated_by_user_at is null then excluded.role_label else user_personas.role_label end,
         goals = case when user_personas.updated_by_user_at is null then excluded.goals else user_personas.goals end,
         preferences = case when user_personas.updated_by_user_at is null then excluded.preferences else user_personas.preferences end,
         avoided_topics = case when user_personas.updated_by_user_at is null then excluded.avoided_topics else user_personas.avoided_topics end,
         memory_enabled = user_personas.memory_enabled,
         analyzed_at = now(),
         updated_at = now()`,
      [
        userId,
        mergedProfile.summary,
        mergedProfile.role_label,
        mergedProfile.goals,
        mergedProfile.preferences,
        mergedProfile.avoided_topics,
        mergedProfile.memory_enabled,
      ]
    );

    await client.query(
      `delete from user_persona_observations
       where user_id = $1 and status = 'active'`,
      [userId]
    );
    await client.query(
      `delete from user_interest_topics
       where user_id = $1 and status = 'active'`,
      [userId]
    );
    await client.query(
      `delete from user_question_suggestions
       where user_id = $1 and status = 'active'`,
      [userId]
    );

    for (const observation of generated.observations) {
      await client.query(
        `insert into user_persona_observations (
           user_id,
           category,
           label,
           detail,
           confidence,
           evidence_count,
           evidence_message_ids
         )
         values ($1, $2, $3, $4, $5, $6, $7::uuid[])
         on conflict (user_id, category, label) do update set
           detail = excluded.detail,
           confidence = excluded.confidence,
           evidence_count = excluded.evidence_count,
           evidence_message_ids = excluded.evidence_message_ids,
           status = case
             when user_persona_observations.status in ('accepted', 'hidden', 'rejected')
             then user_persona_observations.status
             else 'active'
           end,
           updated_at = now()`,
        [
          userId,
          observation.category,
          observation.label,
          observation.detail,
          observation.confidence,
          observation.evidence_count,
          observation.evidence_message_ids,
        ]
      );
    }

    for (const interest of generated.interests) {
      await client.query(
        `insert into user_interest_topics (
           user_id,
           topic,
           score,
           trend,
           evidence_count,
           evidence_message_ids,
           last_seen_at
         )
         values ($1, $2, $3, $4, $5, $6::uuid[], $7)
         on conflict (user_id, topic) do update set
           score = excluded.score,
           trend = excluded.trend,
           evidence_count = excluded.evidence_count,
           evidence_message_ids = excluded.evidence_message_ids,
           last_seen_at = excluded.last_seen_at,
           status = case
             when user_interest_topics.status in ('accepted', 'hidden', 'rejected')
             then user_interest_topics.status
             else 'active'
           end,
           updated_at = now()`,
        [
          userId,
          interest.topic,
          interest.score,
          interest.trend,
          interest.evidence_count,
          interest.evidence_message_ids,
          interest.last_seen_at || null,
        ]
      );
    }

    for (const suggestion of generated.suggestions) {
      await client.query(
        `insert into user_question_suggestions (
           user_id,
           topic,
           question,
           reason,
           confidence
         )
         values ($1, $2, $3, $4, $5)
         on conflict (user_id, question) do update set
           topic = excluded.topic,
           reason = excluded.reason,
           confidence = excluded.confidence,
           status = case
             when user_question_suggestions.status in ('hidden', 'used', 'rejected')
             then user_question_suggestions.status
             else 'active'
           end,
           updated_at = now()`,
        [
          userId,
          suggestion.topic,
          suggestion.question,
          suggestion.reason,
          suggestion.confidence,
        ]
      );
    }

    await client.query(
      `insert into user_persona_audit_events (user_id, event_type, target_type, payload)
       values ($1, 'analysis_refreshed', 'profile', $2)`,
      [userId, JSON.stringify({ messageCount: recentMessages.length })]
    );
  });

  return getPersonaCenterForUser(userId);
};

export const updatePersonaInterestStatusForUser = async (
  userId: string,
  interestId: string,
  status: UserInterestTopicRow['status']
) => {
  const { rows } = await query<UserInterestTopicRow>(
    `update user_interest_topics
     set status = $3, updated_at = now()
     where user_id = $1 and id = $2
     returning ${interestColumns}`,
    [userId, interestId, status]
  );
  if (rows[0]) await recordPersonaAuditEvent(userId, 'interest_status_updated', 'interest', interestId, { status });
  return rows[0] || null;
};

export const updatePersonaObservationStatusForUser = async (
  userId: string,
  observationId: string,
  status: UserPersonaObservationRow['status']
) => {
  const { rows } = await query<UserPersonaObservationRow>(
    `update user_persona_observations
     set status = $3, updated_at = now()
     where user_id = $1 and id = $2
     returning ${observationColumns}`,
    [userId, observationId, status]
  );
  if (rows[0]) await recordPersonaAuditEvent(userId, 'observation_status_updated', 'observation', observationId, { status });
  return rows[0] || null;
};

export const updatePersonaSuggestionStatusForUser = async (
  userId: string,
  suggestionId: string,
  status: UserQuestionSuggestionRow['status']
) => {
  const { rows } = await query<UserQuestionSuggestionRow>(
    `update user_question_suggestions
     set status = $3, updated_at = now()
     where user_id = $1 and id = $2
     returning ${suggestionColumns}`,
    [userId, suggestionId, status]
  );
  if (rows[0]) await recordPersonaAuditEvent(userId, 'suggestion_status_updated', 'suggestion', suggestionId, { status });
  return rows[0] || null;
};

export const deletePersonaInterestForUser = async (
  userId: string,
  interestId: string
) => {
  const { rows } = await query<UserInterestTopicRow>(
    `update user_interest_topics
     set status = 'rejected', updated_at = now()
     where user_id = $1 and id = $2
     returning ${interestColumns}`,
    [userId, interestId]
  );
  if (rows[0]) await recordPersonaAuditEvent(userId, 'interest_deleted', 'interest', interestId);
  return rows[0] || null;
};

export const deletePersonaObservationForUser = async (
  userId: string,
  observationId: string
) => {
  const { rows } = await query<UserPersonaObservationRow>(
    `update user_persona_observations
     set status = 'rejected', updated_at = now()
     where user_id = $1 and id = $2
     returning ${observationColumns}`,
    [userId, observationId]
  );
  if (rows[0]) await recordPersonaAuditEvent(userId, 'observation_deleted', 'observation', observationId);
  return rows[0] || null;
};

export const deletePersonaSuggestionForUser = async (
  userId: string,
  suggestionId: string
) => {
  const { rows } = await query<UserQuestionSuggestionRow>(
    `update user_question_suggestions
     set status = 'rejected', updated_at = now()
     where user_id = $1 and id = $2
     returning ${suggestionColumns}`,
    [userId, suggestionId]
  );
  if (rows[0]) await recordPersonaAuditEvent(userId, 'suggestion_deleted', 'suggestion', suggestionId);
  return rows[0] || null;
};

export const deletePersonaProfileForUser = async (userId: string) => {
  await withTransaction(async (client) => {
    await client.query('delete from user_question_suggestions where user_id = $1', [userId]);
    await client.query('delete from user_interest_topics where user_id = $1', [userId]);
    await client.query('delete from user_persona_observations where user_id = $1', [userId]);
    await client.query(
      `insert into user_personas (user_id)
       values ($1)
       on conflict (user_id) do update set
         summary = '',
         role_label = '',
         goals = '{}'::text[],
         preferences = '{}'::text[],
         avoided_topics = '{}'::text[],
         memory_enabled = true,
         updated_by_user_at = null,
         analyzed_at = null,
         updated_at = now()`,
      [userId]
    );
    await client.query(
      `insert into user_persona_audit_events (user_id, event_type, target_type)
       values ($1, 'profile_deleted', 'profile')`,
      [userId]
    );
  });

  return getPersonaCenterForUser(userId);
};

export const resetPersonaCenterForUser = async (userId: string) => {
  await withTransaction(async (client) => {
    await client.query('delete from user_question_suggestions where user_id = $1', [userId]);
    await client.query('delete from user_interest_topics where user_id = $1', [userId]);
    await client.query('delete from user_persona_observations where user_id = $1', [userId]);
    await client.query(
      `insert into user_personas (user_id)
       values ($1)
       on conflict (user_id) do update set
         summary = '',
         role_label = '',
         goals = '{}'::text[],
         preferences = '{}'::text[],
         avoided_topics = '{}'::text[],
         memory_enabled = true,
         updated_by_user_at = null,
         analyzed_at = null,
         updated_at = now()`,
      [userId]
    );
    await client.query(
      `insert into user_persona_audit_events (user_id, event_type, target_type)
       values ($1, 'profile_reset', 'profile')`,
      [userId]
    );
  });

  return getPersonaCenterForUser(userId);
};

export const recordPersonaAuditEvent = async (
  userId: string,
  eventType: string,
  targetType: string,
  targetId?: string | null,
  payload: unknown = {}
) => {
  await query(
    `insert into user_persona_audit_events (user_id, event_type, target_type, target_id, payload)
     values ($1, $2, $3, $4, $5)`,
    [userId, eventType, targetType, targetId || null, JSON.stringify(payload)]
  );
};
