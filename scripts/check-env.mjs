import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const weakJwtSecrets = new Set([
  'super-secret-jwt-key-change-me',
  'change-me',
  'changeme',
  'replace-me',
  'replace-with-a-long-random-secret',
]);

const serverRules = {
  required: ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'JWT_SECRET'],
  forbiddenPrefixes: ['SUPABASE_'],
  jwtSecretKey: 'JWT_SECRET',
  atLeastOne: [['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY']],
};

const ragRules = {
  required: [
    'DATABASE_URL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'MILVUS_URI',
    'MILVUS_COLLECTION',
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL',
    'EMBEDDING_DIMENSION',
  ],
  forbiddenPrefixes: ['SUPABASE_'],
};

export function parseEnvContent(content) {
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function validateEnvMap(label, env, rules) {
  const issues = [];
  const missing = (rules.required || []).filter((key) => !env[key]?.trim());

  if (missing.length > 0) {
    issues.push(`${label} is missing required keys: ${missing.join(', ')}`);
  }

  const forbidden = Object.keys(env).filter((key) =>
    (rules.forbiddenPrefixes || []).some((prefix) => key.startsWith(prefix))
  );

  if (forbidden.length > 0) {
    issues.push(`${label} contains unsupported keys: ${forbidden.join(', ')}`);
  }

  if (rules.jwtSecretKey) {
    const secret = env[rules.jwtSecretKey]?.trim();
    if (secret && (weakJwtSecrets.has(secret) || secret.length < 32)) {
      issues.push(`${label} has an unsafe ${rules.jwtSecretKey} placeholder; replace it with a long random secret`);
    }
  }

  for (const group of rules.atLeastOne || []) {
    if (!group.some((key) => env[key]?.trim())) {
      issues.push(`${label} must define at least one of: ${group.join(', ')}`);
    }
  }

  return issues;
}

export function validateProjectEnvMaps(envMaps) {
  const serverEnv = envMaps['server/.env'] || {};

  return [
    ...validateEnvMap('server/.env', serverEnv, serverRules),
    ...validateServerBackendUrl(serverEnv),
    ...validateEnvMap('rag-service/.env', envMaps['rag-service/.env'] || {}, ragRules),
  ];
}

function validateServerBackendUrl(env) {
  const port = env.PORT?.trim();
  const backendUrl = env.BACKEND_URL?.trim();

  if (!port || !backendUrl) {
    return [];
  }

  try {
    const parsed = new URL(backendUrl);
    const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    const backendPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

    if (isLocalhost && backendPort !== port) {
      return ['server/.env BACKEND_URL port must match PORT for localhost URLs'];
    }
  } catch {
    return [];
  }

  return [];
}

export function readProjectEnvMaps(rootDir = process.cwd()) {
  const files = ['server/.env', 'rag-service/.env'];
  const envMaps = {};
  const issues = [];

  for (const relativePath of files) {
    const absolutePath = path.join(rootDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      issues.push(`${relativePath} does not exist; copy from the matching .env.example and fill local values`);
      envMaps[relativePath] = {};
      continue;
    }

    envMaps[relativePath] = parseEnvContent(fs.readFileSync(absolutePath, 'utf8'));
  }

  return { envMaps, issues };
}

export function checkProjectEnv(rootDir = process.cwd()) {
  const { envMaps, issues } = readProjectEnvMaps(rootDir);
  return [...issues, ...validateProjectEnvMaps(envMaps)];
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).pathname : '';

if (pathToFileURL(currentFile).pathname === invokedFile) {
  const issues = checkProjectEnv(process.cwd());

  if (issues.length > 0) {
    console.error('Configuration check failed:');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  console.log('Configuration check passed.');
}
