import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildRagServiceSpawnConfig,
  buildRagTestSpawnConfig,
  resolvePythonExecutable,
} from './run-rag-service.mjs';

const rootDir = path.resolve('D:/project/chatLLM');

test('resolvePythonExecutable honors an explicit RAG_PYTHON override', () => {
  const python = resolvePythonExecutable({
    rootDir,
    env: { RAG_PYTHON: 'D:/Python/python.exe' },
    existsSync: () => false,
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
  });

  assert.equal(python, 'python');
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
  });

  const hostIndex = config.args.indexOf('--host');
  assert.equal(config.args[hostIndex + 1], '10.20.30.40');
});
