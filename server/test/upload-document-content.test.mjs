import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const routeSource = readFileSync(path.join(serverRoot, 'src/routes/upload.ts'), 'utf8');
const controllerSource = readFileSync(path.join(serverRoot, 'src/controllers/upload.ts'), 'utf8');

test('upload routes expose an authenticated markdown original-content endpoint', () => {
  assert.match(routeSource, /getFileContent/);
  assert.match(routeSource, /router\.get\('\/files\/:id\/content', getFileContent\)/);
  assert.ok(
    routeSource.indexOf("router.get('/files/:id/content', getFileContent)") <
      routeSource.indexOf("router.delete('/files/:id', deleteFile)"),
    'content route should be declared before destructive file actions',
  );
});

test('file content controller streams only the current user document object as markdown', () => {
  assert.match(controllerSource, /export const getFileContent/);
  assert.match(controllerSource, /findFileForUser\(id, req\.user\.id\)/);
  assert.match(controllerSource, /file\.status !== 'completed'/);
  assert.match(controllerSource, /file\.object_key/);
  assert.match(controllerSource, /getObjectStream\(file\.object_key\)/);
  assert.match(controllerSource, /Content-Type/);
  assert.match(controllerSource, /text\/markdown; charset=utf-8/);
  assert.match(controllerSource, /Content-Disposition/);
  assert.match(controllerSource, /stream\.pipe\(res\)/);
});
