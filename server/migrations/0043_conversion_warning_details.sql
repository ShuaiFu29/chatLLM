-- Conversion warnings were only ever counted. `warning_count` told an operator
-- that a document converted imperfectly but never which defect fired, and the
-- warning text lived solely inside the manifest artifact in object storage, so
-- answering "why is this file completed_with_warnings" required downloading and
-- decoding an artifact per file. Persist the codes next to the count so the
-- reason is queryable.
alter table file_conversion_generations
  add column if not exists warnings text[] not null default '{}'::text[];

comment on column file_conversion_generations.warnings is
  'Converter warning codes for this generation. Empty for generations recorded before this column existed, so do not read emptiness as "no warnings" when warning_count > 0.';

-- Guard the two columns against disagreeing. Rows written before this migration
-- keep an empty array with a non-zero count, so only non-empty arrays are
-- required to match.
alter table file_conversion_generations
  drop constraint if exists file_conversion_generations_warning_details_check;
alter table file_conversion_generations
  add constraint file_conversion_generations_warning_details_check
  check (cardinality(warnings) = 0 or cardinality(warnings) = warning_count);

-- token_count has existed since 0032 but was never populated: the column was
-- absent from both INSERT column lists and only present in their RETURNING
-- clauses, so every row read back NULL. It is now written at ingestion time with
-- a deliberately approximate estimator, which the comment records so a consumer
-- does not mistake it for an exact tokenizer count.
comment on column file_chunks.token_count is
  'Approximate token count from the heuristic-cjk-v1 estimator in rag-service/chunk_strategy.py, not an exact tokenizer count. NULL for chunks written before the estimator existed.';
