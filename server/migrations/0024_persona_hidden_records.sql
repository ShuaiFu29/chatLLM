alter table user_question_suggestions
  drop constraint if exists user_question_suggestions_status_check;

alter table user_question_suggestions
  add constraint user_question_suggestions_status_check
  check (status in ('active', 'hidden', 'used', 'rejected'));
