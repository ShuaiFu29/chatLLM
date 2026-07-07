alter table rag_eval_runs
  add column if not exists average_source_recall_score double precision not null default 0,
  add column if not exists average_source_precision_score double precision not null default 0,
  add column if not exists average_citation_accuracy_score double precision not null default 0,
  add column if not exists average_answer_keyword_score double precision not null default 0,
  add column if not exists average_grounding_score double precision not null default 0,
  add column if not exists average_judge_score double precision not null default 0;

alter table rag_eval_results
  add column if not exists source_recall_score double precision not null default 0,
  add column if not exists source_precision_score double precision not null default 0,
  add column if not exists citation_accuracy_score double precision not null default 0,
  add column if not exists answer_keyword_score double precision not null default 0,
  add column if not exists grounding_score double precision not null default 0,
  add column if not exists judge_score double precision not null default 0,
  add column if not exists latency_ms integer not null default 0;

create index if not exists rag_eval_results_grounding_idx
  on rag_eval_results(run_id, grounding_score asc, citation_accuracy_score asc);
