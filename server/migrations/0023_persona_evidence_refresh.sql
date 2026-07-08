delete from user_question_suggestions
where status = 'active';

delete from user_interest_topics
where status = 'active';

delete from user_persona_observations
where status = 'active';

update user_personas
set summary = '',
    role_label = '',
    goals = '{}'::text[],
    preferences = '{}'::text[],
    avoided_topics = '{}'::text[],
    analyzed_at = null,
    updated_at = now()
where updated_by_user_at is null;
