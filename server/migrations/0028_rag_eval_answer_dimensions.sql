alter table rag_eval_results
  add column if not exists actual_answer text not null default '',
  add column if not exists correctness_score real not null default 0,
  add column if not exists completeness_score real not null default 0,
  add column if not exists faithfulness_score real not null default 0,
  add column if not exists citation_precision real not null default 0,
  add column if not exists citation_coverage real not null default 0,
  add column if not exists citation_f1 real not null default 0,
  add column if not exists hallucination_rate real not null default 0,
  add column if not exists prompt_version varchar(128) not null default '',
  add column if not exists model_version varchar(255) not null default '',
  add column if not exists judge_version varchar(128) not null default '',
  add column if not exists verifier_version varchar(128) not null default '',
  add column if not exists claim_evaluation jsonb not null default '{}'::jsonb;
