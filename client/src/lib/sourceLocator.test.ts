import { describe, expect, test } from 'vitest';
import { getSourceLocatorLabel } from './sourceLocator';

describe('source locator labels', () => {
  test.each([
    [{ type: 'pdf', page_start: 3, page_end: 5 }, 'knowledge.sourceLocatorPdfPages', { range: '3–5' }],
    [{ type: 'pptx', slide: 7 }, 'knowledge.sourceLocatorPptxSlides', { range: '7' }],
    [{ type: 'xlsx', sheet: '收入', row_start: 11, row_end: 20 }, 'knowledge.sourceLocatorXlsxRows', { sheet: '收入', range: '11–20' }],
    [{ type: 'csv', row_start: 2, row_end: 8 }, 'knowledge.sourceLocatorCsvRows', { range: '2–8' }],
    [{ type: 'plaintext', line_start: 4, line_end: 4 }, 'knowledge.sourceLocatorLines', { range: '4' }],
    [{ type: 'docx', paragraph_start: 2, paragraph_end: 6 }, 'knowledge.sourceLocatorDocxParagraphs', { paragraphs: '2–6' }],
    [{ type: 'docx', table: 3, row_start: 1, row_end: 4 }, 'knowledge.sourceLocatorDocxTableRows', { tables: '3', rows: '1–4' }],
  ])('formats %#', (locator, key, values) => {
    expect(getSourceLocatorLabel(locator)).toEqual({ key, values });
  });

  test('falls back to the document kind when the locator omits type', () => {
    expect(getSourceLocatorLabel({ page: 9 }, 'pdf')).toEqual({
      key: 'knowledge.sourceLocatorPdfPages',
      values: { range: '9' },
    });
  });

  test('uses the first useful nested locator for a mixed envelope', () => {
    expect(getSourceLocatorLabel({
      type: 'mixed',
      locators: [{ type: 'pdf', page: 2 }],
    })).toEqual({
      key: 'knowledge.sourceLocatorPdfPages',
      values: { range: '2' },
    });
  });
});
