import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
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
const repositorySource = readFileSync(
  path.join(serverRoot, 'src/repositories/files.ts'),
  'utf8',
);
const storageSource = readFileSync(
  path.join(serverRoot, 'src/lib/storage.ts'),
  'utf8',
);

const { HttpException, StreamableFile } = require('@nestjs/common');
const { UploadService, resolveOriginalDocumentContentType } = require(
  path.join(serverRoot, 'dist/modules/upload/upload.service.js'),
);
const { UploadController } = require(
  path.join(serverRoot, 'dist/modules/upload/upload.controller.js'),
);
const { findActiveConvertedFileContentForUser } = require(
  path.join(serverRoot, 'dist/repositories/files.js'),
);
const { buildContentDisposition, buildDerivedMarkdownFilename } = require(
  path.join(serverRoot, 'dist/lib/storage.js'),
);

const activeContent = {
  file_id: '11111111-1111-4111-8111-111111111111',
  filename: '运维手册.pdf',
  document_kind: 'pdf',
  conversion_generation_id: '22222222-2222-4222-8222-222222222222',
  markdown_object_key: 'users/user-1/files/file-1/derived/generation-1/document.md',
  markdown_hash: 'a'.repeat(64),
  markdown_byte_size: 42,
};

const originalFile = (status = 'completed', overrides = {}) => ({
  id: activeContent.file_id,
  user_id: 'user-1',
  filename: '运维手册.pdf',
  file_hash: 'b'.repeat(64),
  file_type: 'application/pdf',
  document_kind: 'pdf',
  declared_mime_type: 'application/pdf',
  detected_mime_type: status === 'completed' ? 'application/pdf' : null,
  object_key: 'users/user-1/files/file-1/raw/original.pdf',
  status,
  progress: 100,
  attempts: 1,
  max_attempts: 3,
  reserved_bytes: 0,
  storage_bytes: 42,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  ...overrides,
});

const expectHttpError = async (operation, status, body) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof HttpException, true);
    assert.equal(error.getStatus(), status);
    assert.deepEqual(error.getResponse(), body);
    return true;
  });
};

test('Nest upload controller exposes authenticated converted-content and original routes', () => {
  assert.match(uploadModuleSource, /@Controller\('upload'\)/);
  assert.match(uploadModuleSource, /@UseGuards\(AuthGuard\)/);
  assert.match(uploadModuleSource, /@Get\('files\/:id\/content'\)/);
  assert.match(uploadModuleSource, /this\.uploadService\.getFileContent\(user\.id, id, requestId\)/);
  assert.match(uploadModuleSource, /@Get\('files\/:id\/original'\)/);
  assert.match(uploadModuleSource, /this\.uploadService\.getFileOriginal\(user\.id, id, requestId\)/);
  assert.match(uploadModuleSource, /@Delete\('files\/:id'\)[\s\S]*@ValidateMutation\(mutationSchemas\.uploadDeleteFile\)/);
  assert.ok(
    uploadModuleSource.indexOf("@Get('files/:id/content')") <
      uploadModuleSource.indexOf("@Delete('files/:id')"),
    'content handler should remain before destructive file actions',
  );
  assert.ok(
    uploadModuleSource.indexOf("@Get('files/:id/original')") <
      uploadModuleSource.indexOf("@Delete('files/:id')"),
    'original handler should remain before destructive file actions',
  );
});

test('upload controller forwards the authenticated owner to both document read services', async () => {
  const calls = [];
  const controller = new UploadController({
    getFileContent: async (...args) => {
      calls.push(['content', ...args]);
      return 'converted';
    },
    getFileOriginal: async (...args) => {
      calls.push(['original', ...args]);
      return 'raw';
    },
  });
  const user = { id: 'user-1' };

  assert.equal(
    await controller.fileContent(user, activeContent.file_id, 'request-content'),
    'converted',
  );
  assert.equal(
    await controller.fileOriginal(user, activeContent.file_id, 'request-original'),
    'raw',
  );
  assert.deepEqual(calls, [
    ['content', 'user-1', activeContent.file_id, 'request-content'],
    ['original', 'user-1', activeContent.file_id, 'request-original'],
  ]);
});

test('converted content repository requires owner, completed file, and active completed generation', async () => {
  const calls = [];
  const result = await findActiveConvertedFileContentForUser(
    activeContent.file_id,
    'user-1',
    async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [activeContent] };
    },
  );

  assert.deepEqual(result, activeContent);
  assert.deepEqual(calls[0].params, [activeContent.file_id, 'user-1']);
  assert.match(calls[0].sql, /target_file\.user_id = \$2/i);
  assert.match(calls[0].sql, /target_file\.status = 'completed'/i);
  assert.match(
    calls[0].sql,
    /generation\.id = target_file\.active_conversion_generation_id[\s\S]*generation\.file_id = target_file\.id/i,
  );
  assert.match(calls[0].sql, /generation\.status in \('completed', 'completed_with_warnings'\)/i);
  assert.doesNotMatch(calls[0].sql, /target_file\.object_key/i);
});

test('converted content service streams only the active generation Markdown artifact', async () => {
  const service = new UploadService();
  const openedKeys = [];
  const response = await service.getFileContent('user-1', activeContent.file_id, undefined, {
    findActiveContent: async (fileId, userId) => {
      assert.equal(fileId, activeContent.file_id);
      assert.equal(userId, 'user-1');
      return activeContent;
    },
    openObject: async (key) => {
      openedKeys.push(key);
      return { stream: Readable.from(['converted markdown']) };
    },
  });

  assert.deepEqual(openedKeys, [activeContent.markdown_object_key]);
  assert.equal(response.body instanceof StreamableFile, true);
  assert.equal(response.options.headers['Content-Type'], 'text/markdown; charset=utf-8');
  assert.match(response.options.headers['Content-Disposition'], /^inline;/);
  assert.match(response.options.headers['Content-Disposition'], /filename="____\.md"/);
  assert.match(response.options.headers['Content-Disposition'], /filename\*=UTF-8''%E8%BF%90/);
  assert.equal(response.options.headers['Cache-Control'], 'private, max-age=60');
  assert.equal(response.options.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.options.headers.ETag, `"${activeContent.markdown_hash}"`);
});

test('converted content never falls back to the raw original without an active generation', async () => {
  const service = new UploadService();
  let opened = false;
  await expectHttpError(
    () => service.getFileContent('user-1', activeContent.file_id, undefined, {
      findActiveContent: async () => null,
      openObject: async () => {
        opened = true;
        throw new Error('must not open raw storage');
      },
    }),
    404,
    { error: 'File content not found' },
  );
  assert.equal(opened, false);

  await expectHttpError(
    () => service.getFileContent('user-1', activeContent.file_id, undefined, {
      findActiveContent: async () => activeContent,
      openObject: async () => { throw { name: 'NoSuchKey' }; },
    }),
    404,
    { error: 'File content not found' },
  );
  assert.doesNotMatch(
    serviceSource.split('async getFileContent', 2)[1].split('async getFileOriginal', 1)[0],
    /file\.object_key|getFileForUser/,
  );
});

test('original service authorizes by owner and streams allowed file states as attachments', async () => {
  for (const status of ['pending', 'processing', 'failed', 'completed']) {
    const service = new UploadService();
    const file = originalFile(status);
    const response = await service.getFileOriginal('user-1', file.id, undefined, {
      findOriginal: async (fileId, userId) => {
        assert.deepEqual([fileId, userId], [file.id, 'user-1']);
        return file;
      },
      openObject: async (key) => {
        assert.equal(key, file.object_key);
        return { stream: Readable.from(['original']), contentType: 'application/pdf' };
      },
    });

    assert.equal(response.body instanceof StreamableFile, true);
    assert.match(response.options.headers['Content-Disposition'], /^attachment;/);
    assert.equal(response.options.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(
      response.options.headers['Content-Type'],
      status === 'completed' ? 'application/pdf' : 'application/octet-stream',
    );
  }
});

test('original service returns the same 404 for unauthorized, ineligible, and missing objects', async () => {
  const service = new UploadService();
  const expectedBody = { error: 'File original not found' };

  await expectHttpError(
    () => service.getFileOriginal('user-1', activeContent.file_id, undefined, {
      findOriginal: async () => null,
    }),
    404,
    expectedBody,
  );

  for (const status of ['uploading', 'deleting']) {
    await expectHttpError(
      () => service.getFileOriginal('user-1', activeContent.file_id, undefined, {
        findOriginal: async () => originalFile(status),
      }),
      404,
      expectedBody,
    );
  }

  await expectHttpError(
    () => service.getFileOriginal('user-1', activeContent.file_id, undefined, {
      findOriginal: async () => originalFile('completed'),
      openObject: async () => { throw { name: 'NoSuchKey' }; },
    }),
    404,
    expectedBody,
  );
});

test('document query and storage failures return safe 503 responses', async () => {
  const service = new UploadService();
  const secret = 'private-storage-or-database-detail';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    await expectHttpError(
      () => service.getFileContent('user-1', activeContent.file_id, 'request-query', {
        findActiveContent: async () => { throw new Error(secret); },
      }),
      503,
      { error: 'File content is unavailable' },
    );
    await expectHttpError(
      () => service.getFileOriginal('user-1', activeContent.file_id, 'request-storage', {
        findOriginal: async () => originalFile('completed'),
        openObject: async () => { throw new Error(secret); },
      }),
      503,
      { error: 'File original is unavailable' },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(secret));
});

test('original MIME policy trusts validated types and safely downgrades unvalidated files', () => {
  assert.equal(
    resolveOriginalDocumentContentType(originalFile('completed'), 'application/octet-stream'),
    'application/pdf',
  );
  assert.equal(
    resolveOriginalDocumentContentType(
      originalFile('completed', { detected_mime_type: null }),
      'application/pdf; charset=binary',
    ),
    'application/pdf',
  );
  assert.equal(
    resolveOriginalDocumentContentType(
      originalFile('failed', { detected_mime_type: null }),
      'application/pdf',
    ),
    'application/octet-stream',
  );
  assert.equal(
    resolveOriginalDocumentContentType(
      originalFile('completed', {
        detected_mime_type: 'text/html',
        file_type: 'text/html',
      }),
      'text/html',
    ),
    'application/octet-stream',
  );
});

test('storage filename helpers prevent header injection and produce a Markdown filename', () => {
  assert.equal(buildDerivedMarkdownFilename('folder/report.pdf'), 'report.md');
  const header = buildContentDisposition('attachment', '报告\r\nX-Evil: yes.pdf');
  assert.match(header, /^attachment; filename=/);
  assert.doesNotMatch(header, /[\r\n]/);
  assert.doesNotMatch(header, /X-Evil: yes/);
  assert.match(header, /filename\*=UTF-8''/);
  assert.match(storageSource, /path\.basename/);
  assert.match(storageSource, /encodeURIComponent/);
});

test('repository and service sources never treat a raw object as converted Markdown', () => {
  assert.match(repositorySource, /markdown_object_key/);
  assert.match(serviceSource, /dependencies\.openObject\(content\.markdown_object_key\)/);
  assert.match(serviceSource, /text\/markdown; charset=utf-8/);
  assert.match(serviceSource, /X-Content-Type-Options/);
  assert.match(serviceSource, /markdownEtag\(content\.markdown_hash\)/);
});
