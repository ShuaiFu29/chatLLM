import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toSafeError } from './safe-error.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverRequire = createRequire(path.join(rootDir, 'server', 'package.json'));
const { Client } = serverRequire('pg');
const {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} = serverRequire('@aws-sdk/client-s3');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const smokeDocument = Buffer.from(
  '# ChatLLM RAG smoke\n\nThis temporary document proves ChatLLM can ingest markdown into Milvus and retrieve it through the RAG service. The verification phrase is cobalt smoke marker.\n',
  'utf8'
);

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const content = fs.readFileSync(filePath, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs, init = {}) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, init);
      const body = await response.json();
      if (response.ok) return body;
      lastError = new Error(`${response.status} ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function ensureBucket(s3, bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function main() {
  const skipEnvFiles = process.env.RAG_SMOKE_SKIP_ENV_FILES === 'true';
  const serverEnv = skipEnvFiles ? {} : parseEnv(path.join(rootDir, 'server', '.env'));
  const ragEnv = skipEnvFiles ? {} : parseEnv(path.join(rootDir, 'rag-service', '.env'));
  const configuredValue = (key, fallback = '') => (
    process.env[key] || serverEnv[key] || ragEnv[key] || fallback
  );
  const port = Number(process.env.RAG_SMOKE_PORT || await findFreePort());
  const ragUrl = `http://127.0.0.1:${port}`;
  const collection = process.env.RAG_SMOKE_COLLECTION
    || `${configuredValue('MILVUS_COLLECTION', 'document_chunks')}_local_smoke`;
  const bucket = configuredValue('S3_BUCKET', 'documents');
  const ragToken = configuredValue('RAG_SERVICE_TOKEN');
  if (ragToken.length < 32) {
    throw new Error('RAG_SERVICE_TOKEN must be configured with at least 32 characters for smoke tests');
  }
  const ragHeaders = {
    'content-type': 'application/json',
    'X-ChatLLM-RAG-Token': ragToken,
  };
  const fileId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const projectSpaceId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const leaseToken = crypto.randomUUID();
  const objectKey = `e2e-smoke/${fileId}.md`;
  const githubId = Number(`${Date.now()}`.slice(-12));

  const s3 = new S3Client({
    endpoint: configuredValue('S3_ENDPOINT'),
    region: configuredValue('S3_REGION', 'us-east-1'),
    forcePathStyle: (configuredValue('S3_FORCE_PATH_STYLE', 'true').toLowerCase() !== 'false'),
    credentials: {
      accessKeyId: configuredValue('S3_ACCESS_KEY'),
      secretAccessKey: configuredValue('S3_SECRET_KEY'),
    },
  });

  const db = new Client({ connectionString: configuredValue('DATABASE_URL') });
  let ragProcess;
  let stdout = '';
  let stderr = '';
  let smokeStage = 'initialize';

  async function cleanup() {
    try {
      await fetch(`${ragUrl}/cleanup-file`, {
        method: 'POST',
        headers: ragHeaders,
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {}

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    } catch {}

    try {
      await db.query('delete from users where id = $1', [userId]);
    } catch {}

    if (ragProcess && !ragProcess.killed) {
      ragProcess.kill('SIGTERM');
      await sleep(750);
      if (ragProcess.exitCode === null) ragProcess.kill('SIGKILL');
    }
  }

  try {
    const env = {
      ...ragEnv,
      ...process.env,
      PORT: String(port),
      DATABASE_URL: configuredValue('DATABASE_URL'),
      S3_ENDPOINT: configuredValue('S3_ENDPOINT'),
      S3_ACCESS_KEY: configuredValue('S3_ACCESS_KEY'),
      S3_SECRET_KEY: configuredValue('S3_SECRET_KEY'),
      S3_BUCKET: bucket,
      S3_REGION: configuredValue('S3_REGION', 'us-east-1'),
      S3_FORCE_PATH_STYLE: configuredValue('S3_FORCE_PATH_STYLE', 'true'),
      MILVUS_URI: configuredValue('MILVUS_URI'),
      MILVUS_COLLECTION: collection,
      ELASTICSEARCH_URL: configuredValue('ELASTICSEARCH_URL', 'http://127.0.0.1:9200'),
      ELASTICSEARCH_ENABLED: configuredValue('ELASTICSEARCH_ENABLED', 'true'),
      NEO4J_URL: configuredValue('NEO4J_URL', 'http://127.0.0.1:7474'),
      NEO4J_USER: configuredValue('NEO4J_USER', 'neo4j'),
      NEO4J_PASSWORD: configuredValue('NEO4J_PASSWORD'),
      NEO4J_DATABASE: configuredValue('NEO4J_DATABASE', 'neo4j'),
      NEO4J_ENABLED: configuredValue('NEO4J_ENABLED', 'true'),
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_DIMENSION: configuredValue('EMBEDDING_DIMENSION', '1024'),
      RAG_SERVICE_TOKEN: ragToken,
      PYTHONUNBUFFERED: '1',
    };

    ragProcess = spawn(
      process.env.RAG_SMOKE_PYTHON || 'python',
      ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: path.join(rootDir, 'rag-service'),
        env,
        windowsHide: true,
      }
    );

    ragProcess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    ragProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    smokeStage = 'readiness';
    await waitForJson(`${ragUrl}/health/ready`, 60000, { headers: ragHeaders });

    smokeStage = 'database_connect';
    await db.connect();
    smokeStage = 'object_storage_prepare';
    await ensureBucket(s3, bucket);
    smokeStage = 'object_upload';
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: 'text/markdown',
      Body: smokeDocument,
    }));
    const smokeHash = crypto.createHash('sha256').update(smokeDocument).digest('hex');

    smokeStage = 'database_seed';
    await db.query('begin');
    await db.query(
      `insert into users (id, github_id, username, avatar_url, display_name)
       values ($1, $2, $3, '', $4)`,
      [userId, githubId, `rag-smoke-${githubId}`, 'RAG Smoke']
    );
    await db.query(
      `insert into project_spaces (id, user_id, name, is_default)
       values ($1, $2, 'RAG Smoke Space', true)`,
      [projectSpaceId, userId]
    );
    await db.query(
      `insert into files (
         id, user_id, project_space_id, filename, file_hash, file_size,
         file_type, document_kind, object_key,
         status, progress, max_attempts
       )
       values (
         $1, $2, $3, 'rag-smoke.md', $4, $5,
         'text/markdown', 'markdown', $6,
         'processing', 0, 3
       )`,
      [fileId, userId, projectSpaceId, smokeHash, smokeDocument.length, objectKey]
    );
    await db.query(
      `insert into file_ingestion_jobs (
         file_id, user_id, project_space_id, status, stage, progress,
         attempt_id, lease_token, lease_expires_at
       )
       values ($1, $2, $3, 'processing', 'claimed', 0, $4, $5, now() + interval '10 minutes')`,
      [fileId, userId, projectSpaceId, attemptId, leaseToken]
    );
    await db.query('commit');

    smokeStage = 'ingest';
    const ingestResponse = await fetch(`${ragUrl}/ingest-sync`, {
      method: 'POST',
      headers: ragHeaders,
      body: JSON.stringify({ file_id: fileId, attempt_id: attemptId, lease_token: leaseToken }),
    });
    const ingestBody = await ingestResponse.text();
    if (!ingestResponse.ok) {
      smokeStage = `ingest_http_${ingestResponse.status}`;
      throw new Error(`ingest failed: ${ingestResponse.status} ${ingestBody}`);
    }

    smokeStage = 'ingestion_completion';
    let ingestionRow = null;
    let chunkCount = 0;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const ingestionResult = await db.query(
        'select status, progress, error_message from file_ingestion_jobs where file_id = $1',
        [fileId]
      );
      ingestionRow = ingestionResult.rows[0];
      const chunkResult = await db.query('select count(*)::int as count from file_chunks where file_id = $1', [fileId]);
      chunkCount = chunkResult.rows[0]?.count || 0;

      if (ingestionRow?.status === 'completed') break;
      if (ingestionRow?.status === 'failed') {
        throw new Error(`ingest marked failed: ${ingestionRow.error_message}`);
      }
      await sleep(1000);
    }

    if (ingestionRow?.status !== 'completed') {
      throw new Error(`ingest did not complete, last status=${ingestionRow?.status}, progress=${ingestionRow?.progress}`);
    }

    // /ingest-sync exercises the RAG service directly. In production the
    // server reconciles the completed ingestion job and publishes the file;
    // mirror that contract here so retrieval's completed-file authority gate
    // is tested instead of bypassed.
    smokeStage = 'file_publication';
    const publicationResult = await db.query(
      `update files
       set status = 'completed',
           progress = 100,
           error_message = null,
           next_attempt_at = null,
           updated_at = now()
       where id = $1
         and status = 'processing'
       returning id`,
      [fileId]
    );
    if (publicationResult.rowCount !== 1) {
      throw new Error('smoke file publication did not transition exactly one row');
    }

    smokeStage = 'retrieve';
    const retrieveResponse = await fetch(`${ragUrl}/retrieve`, {
      method: 'POST',
      headers: ragHeaders,
      body: JSON.stringify({
        query: 'Where is the cobalt smoke marker documented?',
        user_id: userId,
        project_space_id: projectSpaceId,
        limit: 3,
        threshold: 0,
      }),
    });
    smokeStage = 'retrieve_response';
    const retrieveBody = await retrieveResponse.json();
    if (!retrieveResponse.ok) {
      smokeStage = `retrieve_http_${retrieveResponse.status}`;
      throw new Error(`retrieve failed: ${retrieveResponse.status} ${JSON.stringify(retrieveBody)}`);
    }
    smokeStage = 'retrieve_assertion';
    if (!Array.isArray(retrieveBody.results) || retrieveBody.results.length === 0) {
      smokeStage = 'retrieve_empty';
      let authority = { unavailable: true };
      try {
        const authorityResult = await db.query(
          `select
             target_file.status as file_status,
             target_file.document_kind,
             active_generation.status as generation_status,
             count(target_chunk.id)::int as chunk_count,
             count(target_chunk.id) filter (
               where target_chunk.conversion_generation_id = target_file.active_conversion_generation_id
             )::int as active_generation_chunk_count,
             count(target_chunk.id) filter (
               where target_chunk.conversion_generation_id is null
             )::int as legacy_chunk_count
           from files target_file
           left join file_conversion_generations active_generation
             on active_generation.id = target_file.active_conversion_generation_id
            and active_generation.file_id = target_file.id
           left join file_chunks target_chunk on target_chunk.file_id = target_file.id
           where target_file.id = $1
           group by target_file.status, target_file.document_kind, active_generation.status`,
          [fileId]
        );
        authority = authorityResult.rows[0] || { missing_file: true };
      } catch {
        authority = { unavailable: true };
      }
      console.error('[rag-smoke] empty retrieval diagnostics:', {
        channel_status: retrieveBody?.channel_status || {},
        degraded: Boolean(retrieveBody?.degraded),
        authority,
      });
      throw new Error(`retrieve returned no results: ${JSON.stringify(retrieveBody)}`);
    }

    console.log(JSON.stringify({
      status: 'ok',
      ragUrl,
      collection,
      fileId,
      ingestStatus: ingestionRow.status,
      progress: ingestionRow.progress,
      chunkCount,
      retrieved: retrieveBody.results.length,
      firstResultPreview: retrieveBody.results[0].content.slice(0, 120),
    }, null, 2));
  } catch (error) {
    console.error('[rag-smoke] failed:', { stage: smokeStage, ...toSafeError(error) });
    if (stdout.trim() || stderr.trim()) {
      console.error('[rag-smoke] RAG process emitted diagnostics:', {
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
      });
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
    await db.end().catch(() => {});
  }
}

await main();
