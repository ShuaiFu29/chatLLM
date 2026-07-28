import { describe, expect, test } from 'vitest';
import { findCitationLocation, getOriginalDocumentDownloadUrl } from './documentPreview';

describe('converted Markdown preview', () => {
  test('finds and highlights the matching converted Markdown section', () => {
    const content = '# Intro\n\nOverview.\n\n# Deployment\n\nRun the migration before restarting the service.\n';
    const location = findCitationLocation(content, 'Run the migration before restarting the service.');

    expect(location?.found).toBe(true);
    expect(content.slice(location!.start, location!.end)).toContain('# Deployment');
  });

  test('falls back to the full converted document when a citation cannot be located', () => {
    const content = '# Guide\n\nOnly the indexed source content is rendered here.\n';
    expect(findCitationLocation(content, 'completely unrelated citation text')).toEqual({
      start: 0,
      end: content.length,
      found: false,
    });
  });

  test('builds an encoded original download endpoint separately from the preview endpoint', () => {
    expect(getOriginalDocumentDownloadUrl('file/id')).toBe('/api/upload/files/file%2Fid/original');
  });
});
