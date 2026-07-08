import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAG_DEPENDENCY_CHECK = 'import uvicorn, fastapi, psycopg';

function defaultIsPythonUsable(command) {
  const result = spawnSync(command, ['-c', RAG_DEPENDENCY_CHECK], {
    stdio: 'ignore',
    timeout: 5000,
  });
  return result.status === 0;
}

export function resolvePythonExecutable({
  rootDir = scriptRoot,
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
  isPythonUsable = defaultIsPythonUsable,
} = {}) {
  if (env.RAG_PYTHON) return env.RAG_PYTHON;

  const candidates = platform === 'win32'
    ? [
        path.join(rootDir, '.venv', 'Scripts', 'python.exe'),
        path.join(rootDir, 'rag-service', '.venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(rootDir, '.venv', 'bin', 'python'),
        path.join(rootDir, 'rag-service', '.venv', 'bin', 'python'),
      ];

  return candidates.find((candidate) => existsSync(candidate) && isPythonUsable(candidate))
    || (platform === 'win32' ? 'python' : 'python3');
}

export function buildRagServiceSpawnConfig({
  rootDir = scriptRoot,
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  isPythonUsable = defaultIsPythonUsable,
} = {}) {
  const port = env.RAG_PORT || env.PORT || '8000';

  return {
    command: resolvePythonExecutable({ rootDir, env, platform, existsSync, isPythonUsable }),
    args: [
      '-m',
      'uvicorn',
      'main:app',
      '--reload',
      '--host',
      '0.0.0.0',
      '--port',
      port,
    ],
    options: {
      cwd: path.join(rootDir, 'rag-service'),
      stdio: 'inherit',
      env,
    },
  };
}

export function buildRagTestSpawnConfig({
  rootDir = scriptRoot,
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  isPythonUsable = defaultIsPythonUsable,
} = {}) {
  return {
    command: resolvePythonExecutable({ rootDir, env, platform, existsSync, isPythonUsable }),
    args: ['-m', 'unittest', 'discover', '-s', 'tests'],
    options: {
      cwd: path.join(rootDir, 'rag-service'),
      stdio: 'inherit',
      env,
    },
  };
}

export function startRagService(config = buildRagServiceSpawnConfig()) {
  const child = spawn(config.command, config.args, config.options);

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(`[RAG] Failed to start Python service with ${config.command}: ${error.message}`);
    process.exit(1);
  });

  return child;
}

export function runRagTests(config = buildRagTestSpawnConfig()) {
  return startRagService(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--test')) {
    runRagTests();
  } else {
    startRagService();
  }
}
