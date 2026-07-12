import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, FileText, Loader2, MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';
import Modal from './Modal';

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

export interface DocumentReference {
  id: string;
  filename: string;
  citationContent?: string;
  chunkIndex?: number;
}

interface DocumentViewerModalProps {
  document: DocumentReference | null;
  onClose: () => void;
}

type ViewMode = 'rendered' | 'raw';

const formatFilename = (filename: string) => filename.replace(/\.(?:md|markdown)$/i, '').trim();

interface DocumentSection {
  start: number;
  end: number;
  text: string;
}

interface CitationLocation {
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
        return {
          start,
          end,
          text: content.slice(start, end),
        };
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
    if (text.trim()) {
      sections.push({ start: cursor, end, text });
    }
    cursor = boundaryPattern.lastIndex;
  }

  const trailingText = content.slice(cursor);
  if (trailingText.trim()) {
    sections.push({ start: cursor, end: content.length, text: trailingText });
  }

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

  const matchedTokens = tokens.filter((token) => normalizedSection.includes(token)).length;
  return matchedTokens / tokens.length;
};

const findCitationLocation = (
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
    return {
      start: bestSection.section.start,
      end: bestSection.section.end,
      found: true,
    };
  }

  return { start: 0, end: documentContent.length, found: false };
};

export default function DocumentViewerModal({ document, onClose }: DocumentViewerModalProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('rendered');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const citationTargetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!document?.id) return;

    let isActive = true;

    const loadDocument = async () => {
      setIsLoading(true);
      setError(null);
      setContent('');
      setViewMode('rendered');

      try {
        const response = await api.get<string>(`/upload/files/${document.id}/content`, {
          responseType: 'text',
          headers: { Accept: 'text/markdown,text/plain' },
        });
        if (!isActive) return;
        setContent(typeof response.data === 'string' ? response.data : String(response.data || ''));
      } catch (loadError) {
        if (!isActive) return;
        console.error('Failed to load document content:', toSafeError(loadError));
        setError(t('knowledge.loadDocumentFailed'));
      } finally {
        if (isActive) setIsLoading(false);
      }
    };

    void loadDocument();

    return () => {
      isActive = false;
    };
  }, [document?.id, t]);

  const displayName = useMemo(
    () => formatFilename(document?.filename || ''),
    [document?.filename]
  );

  const citationLocation = useMemo(
    () => findCitationLocation(content, document?.citationContent),
    [content, document?.citationContent]
  );

  const hasCitation = Boolean(document?.citationContent?.trim());
  const citationStart = citationLocation?.found ? citationLocation.start : -1;

  useEffect(() => {
    if (viewMode !== 'rendered' || citationStart < 0) return;

    const scrollTimer = window.setTimeout(() => {
      citationTargetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);

    return () => window.clearTimeout(scrollTimer);
  }, [citationStart, viewMode]);

  const beforeCitation = citationLocation?.found ? content.slice(0, citationLocation.start) : '';
  const citationMarkdown = citationLocation?.found ? content.slice(citationLocation.start, citationLocation.end) : '';
  const afterCitation = citationLocation?.found ? content.slice(citationLocation.end) : '';

  return (
    <Modal
      isOpen={!!document}
      onClose={onClose}
      title={t('knowledge.documentPreview')}
      maxWidth="3xl"
      footer={
        <button
          onClick={onClose}
          className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
        >
          {t('common.close')}
        </button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary">
              <FileText className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-text-main">{displayName}</p>
              <p className="text-xs text-text-muted">{t('knowledge.originalMarkdownHint')}</p>
            </div>
          </div>

          <div className="inline-flex rounded-lg border border-border bg-bg-base p-1 text-xs">
            <button
              onClick={() => setViewMode('rendered')}
              className={`rounded-md px-3 py-1.5 transition-colors ${viewMode === 'rendered' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-main'}`}
            >
              {t('knowledge.renderedMarkdown')}
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={`rounded-md px-3 py-1.5 transition-colors ${viewMode === 'raw' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-main'}`}
            >
              {t('knowledge.rawMarkdown')}
            </button>
          </div>
        </div>

        {isLoading && (
          <div className="flex min-h-64 items-center justify-center gap-2 rounded-lg border border-border bg-bg-base text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('knowledge.loadingDocument')}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {!isLoading && !error && content && hasCitation && (
          <div className={`flex items-center gap-2 rounded-lg border p-3 text-xs ${
            citationLocation?.found
              ? 'border-primary/20 bg-primary/10 text-primary'
              : 'border-amber-500/20 bg-amber-500/10 text-amber-300'
          }`}>
            {citationLocation?.found ? <MapPin className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
            {citationLocation?.found ? t('knowledge.citationMatched') : t('knowledge.citationNotFound')}
          </div>
        )}

        {!isLoading && !error && content && viewMode === 'rendered' && (
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-bg-base p-4">
            <Suspense fallback={
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('chat.loadingContent')}
              </div>
            }>
              {citationLocation?.found ? (
                <div className="space-y-4">
                  {beforeCitation.trim() && <MarkdownRenderer content={beforeCitation} />}
                  <div
                    ref={citationTargetRef}
                    data-citation-target="true"
                    aria-label={t('knowledge.citationTarget')}
                    className="rounded-lg border border-primary/50 bg-primary/5 p-3 shadow-[0_0_0_1px_rgba(59,130,246,0.15)]"
                  >
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
                      <MapPin className="h-3.5 w-3.5" />
                      {t('knowledge.citationTarget')}
                    </div>
                    <MarkdownRenderer content={citationMarkdown} />
                  </div>
                  {afterCitation.trim() && <MarkdownRenderer content={afterCitation} />}
                </div>
              ) : (
                <MarkdownRenderer content={content} />
              )}
            </Suspense>
          </div>
        )}

        {!isLoading && !error && content && viewMode === 'raw' && (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-base p-4 font-mono text-xs leading-6 text-text-main">
            {content}
          </pre>
        )}

        {!isLoading && !error && !content && (
          <div className="rounded-lg border border-border bg-bg-base p-6 text-center text-sm text-text-muted">
            {t('knowledge.emptyDocument')}
          </div>
        )}
      </div>
    </Modal>
  );
}
