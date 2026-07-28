import { describe, expect, test } from 'vitest';
import {
  DOCUMENT_TYPE_CAPABILITIES,
  DOCUMENT_UPLOAD_ACCEPT,
  DOCUMENT_UPLOAD_LIMIT_SUMMARY,
  getDocumentTypeCapability,
  isSupportedDocument,
  uploadFile,
  validateDocumentUpload,
} from './uploadManager';

const fileLike = (name: string, size: number) => ({ name, size });

describe('multi-format document upload validation', () => {
  test('derives accepted extensions and limits from the shared registry', () => {
    const expectedExtensions = DOCUMENT_TYPE_CAPABILITIES
      .flatMap((documentType) => documentType.extensions.map((extension) => `.${extension}`));

    expect(DOCUMENT_UPLOAD_ACCEPT.split(',')).toEqual(expectedExtensions);
    for (const documentType of DOCUMENT_TYPE_CAPABILITIES) {
      expect(DOCUMENT_UPLOAD_LIMIT_SUMMARY).toContain(`${documentType.maxBytes / (1024 * 1024)} MB`);
    }
  });

  test.each([
    ['guide.md', 'markdown'],
    ['guide.MARKDOWN', 'markdown'],
    ['notes.txt', 'plaintext'],
    ['manual.pdf', 'pdf'],
    ['contract.docx', 'docx'],
    ['briefing.pptx', 'pptx'],
    ['budget.xlsx', 'xlsx'],
    ['records.csv', 'csv'],
  ])('accepts %s as %s', (name, documentKind) => {
    expect(isSupportedDocument(fileLike(name, 1))).toBe(true);
    expect(getDocumentTypeCapability(name)?.documentKind).toBe(documentKind);
  });

  test.each(['report.doc', 'slides.ppt', 'sheet.xls', 'scan.png', 'README', 'report.pdf.exe']) (
    'rejects unsupported file %s',
    (name) => {
      expect(validateDocumentUpload(fileLike(name, 1))).toEqual({ ok: false, code: 'unsupported' });
    },
  );

  test('accepts an exact per-type size limit and rejects one byte above it', () => {
    for (const documentType of DOCUMENT_TYPE_CAPABILITIES) {
      const extension = documentType.extensions[0];
      const exact = validateDocumentUpload(fileLike(`document.${extension}`, documentType.maxBytes));
      const over = validateDocumentUpload(fileLike(`document.${extension}`, documentType.maxBytes + 1));

      expect(exact.ok).toBe(true);
      expect(over).toMatchObject({
        ok: false,
        code: 'too-large',
        maxBytes: documentType.maxBytes,
        actualBytes: documentType.maxBytes + 1,
      });
    }
  });

  test('rejects an oversized file before starting the hash worker', async () => {
    let workerWasConstructed = false;
    const originalWorker = globalThis.Worker;
    globalThis.Worker = class {
      constructor() {
        workerWasConstructed = true;
      }
    } as unknown as typeof Worker;

    try {
      const pdf = getDocumentTypeCapability('oversized.pdf');
      expect(pdf).not.toBeNull();
      await expect(uploadFile(
        fileLike('oversized.pdf', pdf!.maxBytes + 1) as File,
        () => undefined,
      )).rejects.toThrow(/size limit/i);
      expect(workerWasConstructed).toBe(false);
    } finally {
      globalThis.Worker = originalWorker;
    }
  });
});
