import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildRagServiceSpawnConfig,
  buildRagTestSpawnConfig,
  parseLockedRagVersions,
  resolvePythonExecutable,
} from './run-rag-service.mjs';

const rootDir = path.resolve('.');

test('parseLockedRagVersions reads the critical runtime versions from the hash lock', () => {
  assert.deepEqual(parseLockedRagVersions([
    'fastapi==0.139.0 \\',
    'uvicorn==0.51.0 \\',
    'pydantic==2.13.4 \\',
    'psycopg==3.3.4 \\',
  ].join('\n')), {
    fastapi: '0.139.0',
    uvicorn: '0.51.0',
    pydantic: '2.13.4',
    psycopg: '3.3.4',
  });
});

test('resolvePythonExecutable honors an explicit RAG_PYTHON override', () => {
  const python = resolvePythonExecutable({
    rootDir,
    env: { RAG_PYTHON: 'D:/Python/python.exe' },
    existsSync: () => false,
    isPythonUsable: () => true,
  });

  assert.equal(python, 'D:/Python/python.exe');
});

test('resolvePythonExecutable prefers the project virtualenv before system Python on Windows', () => {
  const projectPython = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  const python = resolvePythonExecutable({
    rootDir,
    platform: 'win32',
    env: {},
    existsSync: (candidate) => candidate === projectPython,
    isPythonUsable: () => true,
  });

  assert.equal(python, projectPython);
});

test('resolvePythonExecutable falls back to python when no virtualenv exists on Windows', () => {
  const python = resolvePythonExecutable({
    rootDir,
    platform: 'win32',
    env: {},
    existsSync: () => false,
    isPythonUsable: () => true,
  });

  assert.equal(python, 'python');
});

test('resolvePythonExecutable rejects interpreters that drift from the dependency lock', () => {
  assert.throws(() => resolvePythonExecutable({
    rootDir,
    platform: 'win32',
    env: { RAG_PYTHON: 'D:/Python/python.exe' },
    existsSync: () => true,
    isPythonUsable: () => false,
  }), /does not match rag-service\/requirements\.txt/);
});

test('resolvePythonExecutable skips a virtualenv that cannot import RAG dependencies', () => {
  const projectPython = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  const ragPython = path.join(rootDir, 'rag-service', '.venv', 'Scripts', 'python.exe');
  const python = resolvePythonExecutable({
    rootDir,
    platform: 'win32',
    env: {},
    existsSync: (candidate) => candidate === projectPython || candidate === ragPython,
    isPythonUsable: (candidate) => candidate === ragPython,
  });

  assert.equal(python, ragPython);
});

test('buildRagServiceSpawnConfig runs uvicorn from the rag-service directory', () => {
  const config = buildRagServiceSpawnConfig({
    rootDir,
    env: { RAG_PORT: '8100' },
    platform: 'win32',
    existsSync: () => false,
    isPythonUsable: () => true,
  });

  assert.equal(config.command, 'python');
  assert.deepEqual(config.args, [
    '-m',
    'uvicorn',
    'main:app',
    '--reload',
    '--host',
    '127.0.0.1',
    '--port',
    '8100',
  ]);
  assert.equal(config.options.cwd, path.join(rootDir, 'rag-service'));
}
);

test('buildRagTestSpawnConfig runs RAG unittest discovery with the resolved Python', () => {
  const projectPython = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  const config = buildRagTestSpawnConfig({
    rootDir,
    env: {},
    platform: 'win32',
    existsSync: (candidate) => candidate === projectPython,
    isPythonUsable: () => true,
  });

  assert.equal(config.command, projectPython);
  assert.deepEqual(config.args, ['-m', 'unittest', 'discover', '-s', 'tests']);
  assert.equal(config.options.cwd, path.join(rootDir, 'rag-service'));
});

test('buildRagServiceSpawnConfig honors an explicit RAG bind host', () => {
  const config = buildRagServiceSpawnConfig({
    rootDir,
    env: { RAG_BIND_HOST: '10.20.30.40' },
    platform: 'win32',
    existsSync: () => false,
    isPythonUsable: () => true,
  });

  const hostIndex = config.args.indexOf('--host');
  assert.equal(config.args[hostIndex + 1], '10.20.30.40');
});
