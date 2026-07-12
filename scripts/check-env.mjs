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
  required: ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'JWT_SECRET', 'RAG_SERVICE_TOKEN'],
  forbiddenPrefixes: ['SUPABASE_', 'OPENAI_'],
  jwtSecretKey: 'JWT_SECRET',
  atLeastOne: [['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'QWEN_API_KEY']],
};

const MIN_FILE_QUEUE_INGEST_TIMEOUT_MS = 60000;

const ragRules = {
  required: [
    'DATABASE_URL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'MILVUS_URI',
    'MILVUS_COLLECTION',
    'EMBEDDING_DIMENSION',
    'RAG_SERVICE_TOKEN',
  ],
  forbiddenPrefixes: ['SUPABASE_'],
};

const infrastructureRules = {
  required: [
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'MINIO_ROOT_USER',
    'MINIO_ROOT_PASSWORD',
    'MILVUS_MINIO_ROOT_USER',
    'MILVUS_MINIO_ROOT_PASSWORD',
    'NEO4J_USER',
    'NEO4J_PASSWORD',
  ],
};

const auditedLegacyInfrastructureValues = new Map([
  ['POSTGRES_PASSWORD', new Set(['chatllm'])],
  ['MINIO_ROOT_USER', new Set(['minioadmin'])],
  ['MINIO_ROOT_PASSWORD', new Set(['minioadmin'])],
  ['MILVUS_MINIO_ROOT_USER', new Set(['minioadmin'])],
  ['MILVUS_MINIO_ROOT_PASSWORD', new Set(['minioadmin'])],
  ['NEO4J_PASSWORD', new Set(['chatllm-password'])],
]);

const infrastructureSecretKeys = [
  'POSTGRES_PASSWORD',
  'MINIO_ROOT_PASSWORD',
  'MILVUS_MINIO_ROOT_PASSWORD',
  'NEO4J_PASSWORD',
];

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
  const infrastructureEnv = envMaps['.env'] || {};
  const serverEnv = envMaps['server/.env'] || {};
  const ragEnv = envMaps['rag-service/.env'] || {};

  const issues = [
    ...validateInfrastructureEnv(infrastructureEnv),
    ...validateEnvMap('server/.env', serverEnv, serverRules),
    ...validateServerModelConfig(serverEnv),
    ...validateServerBackendUrl(serverEnv),
    ...validateServerQueueConfig(serverEnv),
    ...validateRagEnvMap(ragEnv),
  ];

  for (const [label, env] of [['server/.env', serverEnv], ['rag-service/.env', ragEnv]]) {
    const token = env.RAG_SERVICE_TOKEN?.trim();
    if (token && token.length < 32) {
      issues.push(`${label} RAG_SERVICE_TOKEN must be at least 32 characters`);
    }
  }

  const serverToken = serverEnv.RAG_SERVICE_TOKEN?.trim();
  const ragToken = ragEnv.RAG_SERVICE_TOKEN?.trim();
  if (serverToken && ragToken && serverToken !== ragToken) {
    issues.push('server/.env and rag-service/.env RAG_SERVICE_TOKEN values must match');
  }

  return issues;
}

function validateInfrastructureEnv(env) {
  const issues = validateEnvMap('.env', env, infrastructureRules);
  const bindHost = env.INFRA_BIND_HOST?.trim().toLowerCase() || '127.0.0.1';
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const placeholderKeys = infrastructureSecretKeys.filter((key) =>
    /^replace-with-generated-/i.test(env[key]?.trim() || '')
  );

  if (placeholderKeys.length > 0) {
    issues.push(`.env has unsafe infrastructure credential placeholders: ${placeholderKeys.join(', ')}`);
  }

  if (!loopbackHosts.has(bindHost)) {
    const unsafeKeys = [];
    for (const [key, legacyValues] of auditedLegacyInfrastructureValues) {
      if (legacyValues.has(env[key]?.trim())) {
        unsafeKeys.push(key);
      }
    }
    if (unsafeKeys.length > 0) {
      issues.push(`.env has audited legacy infrastructure credentials on a non-loopback bind: ${unsafeKeys.join(', ')}`);
    }
  }

  return issues;
}

function validateServerQueueConfig(env) {
  const rawTimeout = env.FILE_QUEUE_INGEST_TIMEOUT_MS?.trim();
  if (!rawTimeout) return [];

  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (Number.isInteger(timeoutMs) && timeoutMs >= MIN_FILE_QUEUE_INGEST_TIMEOUT_MS) {
    return [];
  }

  return [
    `server/.env FILE_QUEUE_INGEST_TIMEOUT_MS should be at least ${MIN_FILE_QUEUE_INGEST_TIMEOUT_MS} for synchronous RAG ingestion`,
  ];
}

function validateServerModelConfig(env) {
  const defaultModel = env.DEFAULT_CHAT_MODEL?.trim() || '';
  if (/^(gpt-|o\d)/i.test(defaultModel)) {
    return [
      'server/.env DEFAULT_CHAT_MODEL must use a supported provider model such as deepseek-chat, moonshot-v1-8k, or qwen-plus',
    ];
  }

  return [];
}

function validateRagEnvMap(env) {
  const provider = env.EMBEDDING_PROVIDER?.trim().toLowerCase() || 'compatible';
  const judgeEnabled = env.RAG_JUDGE_ENABLED?.trim().toLowerCase() === 'true';
  const issues = validateEnvMap('rag-service/.env', env, ragRules);

  if (!['compatible', 'local'].includes(provider)) {
    issues.push('rag-service/.env EMBEDDING_PROVIDER must be either compatible or local');
    return issues;
  }

  if (provider !== 'local') {
    issues.push(...validateEnvMap('rag-service/.env', env, {
      required: ['EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL'],
    }));
  }

  if (judgeEnabled) {
    issues.push(...validateEnvMap('rag-service/.env', env, {
      required: ['RAG_JUDGE_API_KEY', 'RAG_JUDGE_BASE_URL', 'RAG_JUDGE_MODEL'],
    }));
  }

  return issues;
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
  const files = ['.env', 'server/.env', 'rag-service/.env'];
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
