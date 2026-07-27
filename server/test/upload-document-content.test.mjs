import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const uploadModuleSource = readFileSync(
  path.join(serverRoot, 'src/modules/upload/upload.controller.ts'),
  'utf8',
);
const controllerSource = readFileSync(path.join(serverRoot, 'src/controllers/upload.ts'), 'utf8');

test('Nest upload controller exposes an authenticated markdown original-content endpoint', () => {
  assert.match(uploadModuleSource, /@Controller\('upload'\)/);
  assert.match(uploadModuleSource, /@UseGuards\(AuthGuard\)/);
  assert.match(uploadModuleSource, /@Get\('files\/:id\/content'\)/);
  assert.match(uploadModuleSource, /return getFileContent\(request, reply\)/);
  assert.match(uploadModuleSource, /@Delete\('files\/:id'\)[\s\S]*@ValidateMutation\(mutationSchemas\.uploadDeleteFile\)/);
  assert.ok(
    uploadModuleSource.indexOf("@Get('files/:id/content')") <
      uploadModuleSource.indexOf("@Delete('files/:id')"),
    'content handler should remain before destructive file actions',
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
  assert.match(controllerSource, /streamReadableReply\(stream, res\)/);
});

test('object stream failures before the first byte preserve a JSON error response', async () => {
  const {
    sendHijackedJson,
    streamReadableReply,
  } = require(path.join(serverRoot, 'dist', 'common', 'http', 'raw-stream.js'));
  const chunks = [];
  class FakeResponse extends Writable {
    headers = new Map();
    headersSent = false;
    statusCode = 200;

    _write(chunk, _encoding, callback) {
      this.headersSent = true;
      chunks.push(Buffer.from(chunk));
      callback();
    }

    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    }

    removeHeader(name) {
      this.headers.delete(name.toLowerCase());
    }
  }

  const raw = new FakeResponse();
  const reply = {
    raw,
    sent: false,
    getHeaders: () => ({
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': 'inline; filename=notes.md',
    }),
    hijack() {
      this.sent = true;
    },
  };
  const source = new Readable({
    read() {
      this.destroy(new Error('storage stream failed'));
    },
  });

  await assert.rejects(streamReadableReply(source, reply), /storage stream failed/);
  assert.equal(raw.destroyed, false, 'source errors must not destroy the HTTP response');
  assert.equal(sendHijackedJson(reply, 500, { error: 'Failed to read file content' }), true);
  await new Promise((resolve) => raw.once('finish', resolve));

  assert.equal(raw.statusCode, 500);
  assert.equal(raw.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(raw.headers.has('content-disposition'), false);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
    error: 'Failed to read file content',
  });
});
