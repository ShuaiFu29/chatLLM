import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Download, FileText, Loader2, MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { findCitationLocation, getOriginalDocumentDownloadUrl } from '../lib/documentPreview';
import { toSafeError } from '../lib/safeError';
import { getSourceLocatorLabel, type SourceLocator } from '../lib/sourceLocator';
import Modal from './Modal';

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

export interface DocumentReference {
  id: string;
  filename: string;
  citationContent?: string;
  chunkIndex?: number;
  document_kind?: string;
  conversion_generation_id?: string;
  source_unit_ids?: string[];
  source_locator?: SourceLocator;
}

interface DocumentViewerModalProps {
  document: DocumentReference | null;
  onClose: () => void;
}

type ViewMode = 'rendered' | 'raw';

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

  const citationLocation = useMemo(
    () => findCitationLocation(content, document?.citationContent),
    [content, document?.citationContent]
  );

  const sourceLocatorLabel = useMemo(
    () => getSourceLocatorLabel(document?.source_locator, document?.document_kind),
    [document?.document_kind, document?.source_locator],
  );
  const sourceLocatorText = sourceLocatorLabel
    ? t(sourceLocatorLabel.key, sourceLocatorLabel.values)
    : '';

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
              <p className="truncate text-base font-semibold text-text-main">{document?.filename.trim()}</p>
              <p className="text-xs text-text-muted">{t('knowledge.convertedMarkdownHint')}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={document ? getOriginalDocumentDownloadUrl(document.id) : undefined}
              download={document?.filename}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-base px-3 py-2 text-xs text-text-main transition-colors hover:border-primary hover:text-primary"
            >
              <Download className="h-3.5 w-3.5" />
              {t('knowledge.downloadOriginal')}
            </a>
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
        </div>

        {!isLoading && !error && sourceLocatorText && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 p-3 text-xs text-primary">
            <MapPin className="h-4 w-4 shrink-0" />
            <span>{t('knowledge.sourceLocatorHint', { location: sourceLocatorText })}</span>
          </div>
        )}

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
