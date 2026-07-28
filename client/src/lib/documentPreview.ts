interface DocumentSection {
  start: number;
  end: number;
  text: string;
}

export interface CitationLocation {
  start: number;
  end: number;
  found: boolean;
}

const normalizeForMatch = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

const uniqueValues = (values: string[]) => [...new Set(values.filter(Boolean))];

const buildDocumentSections = (content: string): DocumentSection[] => {
  const headingMatches = [...content.matchAll(/^#{1,6}\s+.+$/gm)];
  if (headingMatches.length > 0) {
    return headingMatches
      .map((match, index) => {
        const start = match.index ?? 0;
        const end = headingMatches[index + 1]?.index ?? content.length;
        return { start, end, text: content.slice(start, end) };
      })
      .filter((section) => section.text.trim().length > 0);
  }

  const sections: DocumentSection[] = [];
  const boundaryPattern = /\n\s*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = boundaryPattern.exec(content)) !== null) {
    const end = match.index;
    const text = content.slice(cursor, end);
    if (text.trim()) sections.push({ start: cursor, end, text });
    cursor = boundaryPattern.lastIndex;
  }

  const trailingText = content.slice(cursor);
  if (trailingText.trim()) sections.push({ start: cursor, end: content.length, text: trailingText });

  return sections.length > 0 ? sections : [{ start: 0, end: content.length, text: content }];
};

const getCitationNeedles = (citationContent: string) => {
  const normalized = normalizeForMatch(citationContent);
  if (normalized.length < 24) return normalized ? [normalized] : [];

  const windowLength = Math.min(180, normalized.length);
  const middleStart = Math.max(0, Math.floor((normalized.length - windowLength) / 2));
  const tailStart = Math.max(0, normalized.length - windowLength);

  return uniqueValues([
    normalized.slice(0, windowLength),
    normalized.slice(middleStart, middleStart + windowLength),
    normalized.slice(tailStart),
  ]).filter((needle) => needle.length >= 24);
};

const scoreSectionMatch = (sectionText: string, citationContent: string) => {
  const normalizedSection = normalizeForMatch(sectionText);
  const normalizedCitation = normalizeForMatch(citationContent);
  const tokens = uniqueValues(normalizedCitation.match(/[\p{L}\p{N}_-]{2,}/gu) || []).slice(0, 80);
  if (tokens.length === 0) return 0;
  return tokens.filter((token) => normalizedSection.includes(token)).length / tokens.length;
};

export const findCitationLocation = (
  documentContent: string,
  citationContent?: string,
): CitationLocation | null => {
  if (!documentContent.trim() || !citationContent?.trim()) return null;

  const sections = buildDocumentSections(documentContent);
  const needles = getCitationNeedles(citationContent);

  for (const section of sections) {
    const normalizedSection = normalizeForMatch(section.text);
    if (needles.some((needle) => normalizedSection.includes(needle))) {
      return { start: section.start, end: section.end, found: true };
    }
  }

  const bestSection = sections
    .map((section) => ({ section, score: scoreSectionMatch(section.text, citationContent) }))
    .sort((left, right) => right.score - left.score)[0];

  if (bestSection && bestSection.score >= 0.35) {
    return { start: bestSection.section.start, end: bestSection.section.end, found: true };
  }

  return { start: 0, end: documentContent.length, found: false };
};

export const getOriginalDocumentDownloadUrl = (documentId: string) => (
  `/api/upload/files/${encodeURIComponent(documentId)}/original`
);
