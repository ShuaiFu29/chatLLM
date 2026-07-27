import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const uploadModuleSource = readFileSync(
  path.join(serverRoot, 'src/modules/upload/upload.controller.ts'),
  'utf8',
);
const serviceSource = readFileSync(
  path.join(serverRoot, 'src/modules/upload/upload.service.ts'),
  'utf8',
);

test('Nest upload controller exposes an authenticated markdown original-content endpoint', () => {
  assert.match(uploadModuleSource, /@Controller\('upload'\)/);
  assert.match(uploadModuleSource, /@UseGuards\(AuthGuard\)/);
  assert.match(uploadModuleSource, /@Get\('files\/:id\/content'\)/);
  assert.match(uploadModuleSource, /this\.uploadService\.getFileContent\(user\.id, id, requestId\)/);
  assert.match(uploadModuleSource, /@Delete\('files\/:id'\)[\s\S]*@ValidateMutation\(mutationSchemas\.uploadDeleteFile\)/);
  assert.ok(
    uploadModuleSource.indexOf("@Get('files/:id/content')") <
      uploadModuleSource.indexOf("@Delete('files/:id')"),
    'content handler should remain before destructive file actions',
  );
});

test('file content controller streams only the current user document object as markdown', () => {
  assert.match(serviceSource, /async getFileContent\(userId: string, id: string/);
  assert.match(serviceSource, /findFileForUser\(id, userId\)/);
  assert.match(serviceSource, /file\.status !== 'completed'/);
  assert.match(serviceSource, /file\.object_key/);
  assert.match(serviceSource, /getObjectStream\(file\.object_key\)/);
  assert.match(serviceSource, /Content-Type/);
  assert.match(serviceSource, /text\/markdown; charset=utf-8/);
  assert.match(serviceSource, /Content-Disposition/);
  assert.match(serviceSource, /new StreamableFile\(stream\)/);
});

test('object stream failures before the first byte preserve a JSON error response', async () => {
  assert.match(serviceSource, /catch \(error\)[\s\S]*?throw new HttpException\(/);
  assert.match(serviceSource, /\{ error: 'File content not found', details: 'File content not found' \}/);
  assert.doesNotMatch(serviceSource, /streamReadableReply|sendHijackedJson|endHijackedReply/);
});
