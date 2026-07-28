export interface SourceLocator {
  type?: string;
  kind?: string;
  line_start?: number;
  line_end?: number;
  page?: number;
  page_start?: number;
  page_end?: number;
  paragraph?: number;
  paragraph_start?: number;
  paragraph_end?: number;
  table?: number;
  table_start?: number;
  table_end?: number;
  row_start?: number;
  row_end?: number;
  slide?: number;
  slide_start?: number;
  slide_end?: number;
  sheet?: string;
  sheets?: Array<{ sheet?: string; sheet_index?: number }>;
  locators?: SourceLocator[];
  [key: string]: unknown;
}

export type SourceLocatorLabel = {
  key:
    | 'knowledge.sourceLocatorLines'
    | 'knowledge.sourceLocatorPdfPages'
    | 'knowledge.sourceLocatorDocxParagraphs'
    | 'knowledge.sourceLocatorDocxTables'
    | 'knowledge.sourceLocatorDocxTableRows'
    | 'knowledge.sourceLocatorDocxParagraphsAndTables'
    | 'knowledge.sourceLocatorPptxSlides'
    | 'knowledge.sourceLocatorXlsxRows'
    | 'knowledge.sourceLocatorXlsxSheet'
    | 'knowledge.sourceLocatorCsvRows';
  values: Record<string, string>;
};

const toPositiveInteger = (value: unknown) => (
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
);

const readRange = (
  locator: SourceLocator,
  startKey: string,
  endKey: string,
  singleKey?: string,
) => {
  const single = singleKey ? toPositiveInteger(locator[singleKey]) : null;
  const start = toPositiveInteger(locator[startKey]) ?? single;
  const end = toPositiveInteger(locator[endKey]) ?? start;
  return start && end ? { start: Math.min(start, end), end: Math.max(start, end) } : null;
};

const formatRange = ({ start, end }: { start: number; end: number }) => (
  start === end ? String(start) : `${start}–${end}`
);

const readSheetName = (locator: SourceLocator) => {
  if (typeof locator.sheet === 'string' && locator.sheet.trim()) return locator.sheet.trim();
  if (!Array.isArray(locator.sheets)) return '';
  return locator.sheets
    .map((sheet) => (typeof sheet?.sheet === 'string' ? sheet.sheet.trim() : ''))
    .filter(Boolean)
    .join(', ');
};

export const getSourceLocatorLabel = (
  locator?: SourceLocator | null,
  documentKind?: string | null,
): SourceLocatorLabel | null => {
  if (!locator) return null;
  const sourceType = typeof locator.type === 'string' && locator.type
    ? locator.type
    : documentKind;

  if (sourceType === 'markdown' || sourceType === 'plaintext') {
    const lines = readRange(locator, 'line_start', 'line_end');
    return lines ? {
      key: 'knowledge.sourceLocatorLines',
      values: { range: formatRange(lines) },
    } : null;
  }

  if (sourceType === 'pdf') {
    const pages = readRange(locator, 'page_start', 'page_end', 'page');
    return pages ? {
      key: 'knowledge.sourceLocatorPdfPages',
      values: { range: formatRange(pages) },
    } : null;
  }

  if (sourceType === 'docx') {
    const paragraphs = readRange(locator, 'paragraph_start', 'paragraph_end', 'paragraph');
    const tables = readRange(locator, 'table_start', 'table_end', 'table');
    const rows = readRange(locator, 'row_start', 'row_end');
    const values: Record<string, string> = {};
    if (paragraphs) values.paragraphs = formatRange(paragraphs);
    if (tables) values.tables = formatRange(tables);
    if (rows) values.rows = formatRange(rows);
    if (paragraphs && tables) {
      return { key: 'knowledge.sourceLocatorDocxParagraphsAndTables', values };
    }
    if (paragraphs) return { key: 'knowledge.sourceLocatorDocxParagraphs', values };
    if (tables) {
      return {
        key: rows ? 'knowledge.sourceLocatorDocxTableRows' : 'knowledge.sourceLocatorDocxTables',
        values,
      };
    }
    return null;
  }

  if (sourceType === 'pptx') {
    const slides = readRange(locator, 'slide_start', 'slide_end', 'slide');
    return slides ? {
      key: 'knowledge.sourceLocatorPptxSlides',
      values: { range: formatRange(slides) },
    } : null;
  }

  if (sourceType === 'xlsx') {
    const sheet = readSheetName(locator);
    if (!sheet) return null;
    const rows = readRange(locator, 'row_start', 'row_end');
    return rows ? {
      key: 'knowledge.sourceLocatorXlsxRows',
      values: { sheet, range: formatRange(rows) },
    } : {
      key: 'knowledge.sourceLocatorXlsxSheet',
      values: { sheet },
    };
  }

  if (sourceType === 'csv') {
    const rows = readRange(locator, 'row_start', 'row_end');
    return rows ? {
      key: 'knowledge.sourceLocatorCsvRows',
      values: { range: formatRange(rows) },
    } : null;
  }

  if (Array.isArray(locator.locators)) {
    for (const nestedLocator of locator.locators) {
      const label = getSourceLocatorLabel(nestedLocator, documentKind);
      if (label) return label;
    }
  }

  return null;
};
