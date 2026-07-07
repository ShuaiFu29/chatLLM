import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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

function parseEnv(filePath) {
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

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
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
  const serverEnv = parseEnv(path.join(rootDir, 'server', '.env'));
  const ragEnv = parseEnv(path.join(rootDir, 'rag-service', '.env'));
  const port = Number(process.env.RAG_SMOKE_PORT || await findFreePort());
  const ragUrl = `http://127.0.0.1:${port}`;
  const collection = process.env.RAG_SMOKE_COLLECTION
    || `${ragEnv.MILVUS_COLLECTION || 'document_chunks'}_local_smoke`;
  const bucket = serverEnv.S3_BUCKET || ragEnv.S3_BUCKET || 'documents';
  const fileId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const projectSpaceId = crypto.randomUUID();
  const objectKey = `e2e-smoke/${fileId}.md`;
  const githubId = Number(`${Date.now()}`.slice(-12));

  const s3 = new S3Client({
    endpoint: serverEnv.S3_ENDPOINT || ragEnv.S3_ENDPOINT,
    region: serverEnv.S3_REGION || ragEnv.S3_REGION || 'us-east-1',
    forcePathStyle: ((serverEnv.S3_FORCE_PATH_STYLE || ragEnv.S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false'),
    credentials: {
      accessKeyId: serverEnv.S3_ACCESS_KEY || ragEnv.S3_ACCESS_KEY,
      secretAccessKey: serverEnv.S3_SECRET_KEY || ragEnv.S3_SECRET_KEY,
    },
  });

  const db = new Client({ connectionString: serverEnv.DATABASE_URL || ragEnv.DATABASE_URL });
  let ragProcess;
  let stdout = '';
  let stderr = '';

  async function cleanup() {
    try {
      await fetch(`${ragUrl}/cleanup-file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
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
      ...process.env,
      ...ragEnv,
      PORT: String(port),
      DATABASE_URL: serverEnv.DATABASE_URL || ragEnv.DATABASE_URL,
      S3_ENDPOINT: serverEnv.S3_ENDPOINT || ragEnv.S3_ENDPOINT,
      S3_ACCESS_KEY: serverEnv.S3_ACCESS_KEY || ragEnv.S3_ACCESS_KEY,
      S3_SECRET_KEY: serverEnv.S3_SECRET_KEY || ragEnv.S3_SECRET_KEY,
      S3_BUCKET: bucket,
      MILVUS_COLLECTION: collection,
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_DIMENSION: ragEnv.EMBEDDING_DIMENSION || '1024',
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

    await waitForJson(`${ragUrl}/health/ready`, 60000);

    await db.connect();
    await ensureBucket(s3, bucket);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: 'text/markdown',
      Body: Buffer.from(
        '# ChatLLM RAG smoke\n\nThis temporary document proves ChatLLM can ingest markdown into Milvus and retrieve it through the RAG service. The verification phrase is cobalt smoke marker.\n',
        'utf8'
      ),
    }));

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
      `insert into files (id, user_id, project_space_id, filename, file_hash, file_size, file_type, object_key, status, progress, max_attempts)
       values ($1, $2, $3, 'rag-smoke.md', $4, $5, 'text/markdown', $6, 'pending', 0, 3)`,
      [fileId, userId, projectSpaceId, crypto.randomBytes(16).toString('hex'), 160, objectKey]
    );
    await db.query('commit');

    const ingestResponse = await fetch(`${ragUrl}/ingest-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const ingestBody = await ingestResponse.text();
    if (!ingestResponse.ok) {
      throw new Error(`ingest failed: ${ingestResponse.status} ${ingestBody}`);
    }

    let fileRow = null;
    let chunkCount = 0;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const fileResult = await db.query('select status, progress, error_message from files where id = $1', [fileId]);
      fileRow = fileResult.rows[0];
      const chunkResult = await db.query('select count(*)::int as count from file_chunks where file_id = $1', [fileId]);
      chunkCount = chunkResult.rows[0]?.count || 0;

      if (fileRow?.status === 'completed') break;
      if (fileRow?.status === 'failed') {
        throw new Error(`ingest marked failed: ${fileRow.error_message}`);
      }
      await sleep(1000);
    }

    if (fileRow?.status !== 'completed') {
      throw new Error(`ingest did not complete, last status=${fileRow?.status}, progress=${fileRow?.progress}`);
    }

    const retrieveResponse = await fetch(`${ragUrl}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'Where is the cobalt smoke marker documented?',
        user_id: userId,
        project_space_id: projectSpaceId,
        limit: 3,
        threshold: 0,
      }),
    });
    const retrieveBody = await retrieveResponse.json();
    if (!retrieveResponse.ok) {
      throw new Error(`retrieve failed: ${retrieveResponse.status} ${JSON.stringify(retrieveBody)}`);
    }
    if (!Array.isArray(retrieveBody.results) || retrieveBody.results.length === 0) {
      throw new Error(`retrieve returned no results: ${JSON.stringify(retrieveBody)}`);
    }

    console.log(JSON.stringify({
      status: 'ok',
      ragUrl,
      collection,
      fileId,
      ingestStatus: fileRow.status,
      progress: fileRow.progress,
      chunkCount,
      retrieved: retrieveBody.results.length,
      firstResultPreview: retrieveBody.results[0].content.slice(0, 120),
    }, null, 2));
  } catch (error) {
    console.error('[rag-smoke] failed:', error);
    if (stdout.trim()) console.error('[rag-smoke] rag stdout:\n' + stdout.trim());
    if (stderr.trim()) console.error('[rag-smoke] rag stderr:\n' + stderr.trim());
    process.exitCode = 1;
  } finally {
    await cleanup();
    await db.end().catch(() => {});
  }
}

await main();
