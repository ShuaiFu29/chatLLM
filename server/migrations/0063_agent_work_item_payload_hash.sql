-- jsonb is free to reorder object keys. Hash the database's canonical text,
-- not the request's original JSON spelling, so recovery can verify old and new
-- rows without treating a harmless key-order change as corruption.
update agent_work_items
set payload_hash = encode(digest(payload::text, 'sha256'), 'hex');

comment on column agent_work_items.payload_hash is
  'SHA-256 of PostgreSQL payload::text; readers verify against payload_text before executing work.';
