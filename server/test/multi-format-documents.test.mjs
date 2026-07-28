import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(
  path.join(serverRoot, 'migrations', '0032_multi_format_documents.sql'),
  'utf8',
);
const uploadController = readFileSync(
  path.join(serverRoot, 'src', 'modules', 'upload', 'upload.controller.ts'),
  'utf8',
);
const uploadService = readFileSync(
  path.join(serverRoot, 'src', 'modules', 'upload', 'upload.service.ts'),
  'utf8',
);

test('multi-format migration records document identity separately from the original object', () => {
  assert.match(migration, /add column if not exists document_kind text not null default 'markdown'/i);
  assert.match(migration, /add column if not exists declared_mime_type text/i);
  assert.match(migration, /add column if not exists detected_mime_type text/i);
  assert.match(
    migration,
    /document_kind in \('markdown', 'plaintext', 'pdf', 'docx', 'pptx', 'xlsx', 'csv'\)/i,
  );
});

test('multi-format migration scopes content claims by document interpretation', () => {
  assert.match(
    migration,
    /alter table file_content_claims[\s\S]*add column if not exists conversion_profile/i,
  );
  assert.match(
    migration,
    /add primary key \(user_id, scope_key, file_hash, conversion_profile\)/i,
  );
});

test('multi-format migration creates versioned conversion generations', () => {
  assert.match(migration, /create table if not exists file_conversion_generations/i);
  for (const column of [
    'source_object_key',
    'markdown_object_key',
    'source_map_object_key',
    'manifest_object_key',
    'converter_name',
    'converter_version',
    'conversion_profile',
    'source_hash',
    'markdown_hash',
  ]) {
    assert.match(migration, new RegExp(`${column} text`, 'i'));
  }
  assert.match(migration, /add column if not exists active_conversion_generation_id uuid/i);
  assert.match(migration, /files_active_conversion_generation_fk/i);
});

test('multi-format migration carries source provenance on durable chunks', () => {
  assert.match(migration, /alter table file_chunks[\s\S]*conversion_generation_id uuid/i);
  assert.match(migration, /source_unit_ids text\[\] not null default '\{\}'::text\[\]/i);
  assert.match(migration, /source_locator jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /content_hash text/i);
  assert.match(migration, /token_count integer/i);
  assert.match(migration, /file_chunks_conversion_generation_fk/i);
});

test('multi-format migration ties the durable ingestion attempt to its generation', () => {
  assert.match(
    migration,
    /alter table file_ingestion_jobs[\s\S]*conversion_generation_id uuid/i,
  );
  assert.match(migration, /file_ingestion_jobs_conversion_generation_fk/i);
});

test('authenticated upload API exposes the authoritative document capabilities', () => {
  assert.match(uploadController, /@Get\('capabilities'\)/);
  assert.match(uploadController, /getDocumentCapabilities\(\)/);
  assert.match(uploadService, /return DOCUMENT_TYPE_REGISTRY/);
});
