-- Keep an Agent's current/published version attached to the same Agent. A
-- plain FK on version id alone allowed a malformed row to point at another
-- Agent's version. A trigger preserves the existing ON DELETE SET NULL
-- lifecycle while enforcing the cross-column invariant on writes.
create or replace function enforce_agent_version_ownership()
returns trigger
language plpgsql
as $$
begin
  if new.current_version_id is not null and not exists (
    select 1 from agent_versions where id = new.current_version_id and agent_id = new.id
  ) then
    raise exception 'current_version_id does not belong to agent';
  end if;
  if new.published_version_id is not null and not exists (
    select 1 from agent_versions where id = new.published_version_id and agent_id = new.id
  ) then
    raise exception 'published_version_id does not belong to agent';
  end if;
  return new;
end;
$$;

drop trigger if exists agents_version_ownership_trigger on agents;
create constraint trigger agents_version_ownership_trigger
after insert or update of current_version_id, published_version_id, id on agents
deferrable initially deferred
for each row execute function enforce_agent_version_ownership();
