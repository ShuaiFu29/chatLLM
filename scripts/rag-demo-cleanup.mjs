import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { toSafeError } from './safe-error.mjs';

const rootDir = process.cwd();
const serverRequire = createRequire(path.join(rootDir, 'server', 'package.json'));
const { Client } = serverRequire('pg');
const { DeleteObjectCommand, S3Client } = serverRequire('@aws-sdk/client-s3');

function parseEnv(filePath) {
  const env = {};
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--confirm');
const serverEnv = parseEnv(path.join(rootDir, 'server', '.env'));
const ragEnv = parseEnv(path.join(rootDir, 'rag-service', '.env'));
const ragUrl = serverEnv.RAG_SERVICE_URL || 'http://localhost:8000';
const bucket = serverEnv.S3_BUCKET || ragEnv.S3_BUCKET || 'documents';

const db = new Client({ connectionString: serverEnv.DATABASE_URL || ragEnv.DATABASE_URL });
const s3 = new S3Client({
  endpoint: serverEnv.S3_ENDPOINT || ragEnv.S3_ENDPOINT,
  region: serverEnv.S3_REGION || ragEnv.S3_REGION || 'us-east-1',
  forcePathStyle: ((serverEnv.S3_FORCE_PATH_STYLE || ragEnv.S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false'),
  credentials: {
    accessKeyId: serverEnv.S3_ACCESS_KEY || ragEnv.S3_ACCESS_KEY,
    secretAccessKey: serverEnv.S3_SECRET_KEY || ragEnv.S3_SECRET_KEY,
  },
});

async function cleanupFile(file) {
  if (dryRun) return;
  try {
    await fetch(`${ragUrl}/cleanup-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: file.id }),
    });
  } catch (error) {
    console.warn('[cleanup] RAG cleanup failed:', toSafeError(error));
  }

  if (file.object_key) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.object_key }));
    } catch (error) {
      console.warn('[cleanup] object cleanup failed:', toSafeError(error));
    }
  }
}

async function main() {
  await db.connect();
  const { rows: users } = await db.query(
    `select id, username
     from users
     where username like 'rag-demo-eval-%'
        or display_name = 'RAG Demo Eval'
     order by created_at desc`
  );
  const { rows: spaces } = await db.query(
    `select ps.id, ps.name, ps.user_id
     from project_spaces ps
     where ps.name like 'RAG Demo %'
     order by ps.created_at desc`
  );
  const userIds = [...new Set([...users.map((user) => user.id), ...spaces.map((space) => space.user_id)])];
  const { rows: files } = userIds.length
    ? await db.query(
      `select id, object_key
       from files
       where user_id = any($1::uuid[])`,
      [userIds]
    )
    : { rows: [] };

  console.log(JSON.stringify({
    dryRun,
    matchedUsers: users.length,
    matchedProjectSpaces: spaces.length,
    matchedFiles: files.length,
    note: dryRun ? 'Dry run only. Re-run with --confirm to delete matched demo data.' : 'Deleting matched demo data.',
  }, null, 2));

  for (const file of files) {
    await cleanupFile(file);
  }

  if (!dryRun) {
    for (const userId of userIds) {
      await db.query('delete from users where id = $1', [userId]);
    }
  }

  await db.end();
}

main().catch(async (error) => {
  console.error('[cleanup] failed:', toSafeError(error));
  await db.end().catch(() => {});
  process.exitCode = 1;
});
