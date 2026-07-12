import { useCallback, useEffect, useState } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';

interface PersonaSuggestion {
  id: string;
  topic: string;
  question: string;
  reason: string;
  confidence: number;
}

interface PersonaCenterResponse {
  suggestions: PersonaSuggestion[];
}

interface PersonaSuggestionsPanelProps {
  onPickSuggestion: (question: string) => void;
}

export default function PersonaSuggestionsPanel({ onPickSuggestion }: PersonaSuggestionsPanelProps) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<PersonaSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadSuggestions = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.get<PersonaCenterResponse>('/persona');
      setSuggestions((res.data.suggestions || []).slice(0, 4));
    } catch (error) {
      console.warn(t('persona.suggestionLoadFailed'), toSafeError(error));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  const updateSuggestionStatus = async (suggestion: PersonaSuggestion, status: 'hidden' | 'used') => {
    setSuggestions((items) => items.filter((item) => item.id !== suggestion.id));
    try {
      await api.patch(`/persona/suggestions/${suggestion.id}`, { status });
    } catch (error) {
      console.warn(t('persona.suggestionLoadFailed'), toSafeError(error));
    }
  };

  if (suggestions.length === 0 && !isLoading) return null;

  return (
    <div className="shrink-0 border-t border-border/50 bg-bg-base px-3 py-2 md:px-6">
      <div className="mx-auto max-h-40 max-w-3xl overflow-y-auto rounded-xl border border-border bg-bg-sidebar p-2 shadow-sm">
        <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium text-text-muted">
          <Lightbulb className="h-3.5 w-3.5 text-primary" />
          <span>{t('persona.likelyQuestions')}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <div
              key={suggestion.id}
              className="group flex max-w-full items-center gap-1 rounded-lg border border-border bg-bg-base px-2 py-1.5"
              title={suggestion.reason}
            >
              <button
                type="button"
                onClick={() => {
                  onPickSuggestion(suggestion.question);
                  void updateSuggestionStatus(suggestion, 'used');
                }}
                className="max-w-[260px] truncate text-left text-xs text-text-main transition-colors hover:text-primary"
                title={t('persona.useQuestion')}
                aria-label={t('persona.useQuestion')}
              >
                {suggestion.question}
              </button>
              <button
                type="button"
                onClick={() => void updateSuggestionStatus(suggestion, 'hidden')}
                className="rounded p-0.5 text-text-muted opacity-70 transition-colors hover:bg-bg-surface hover:text-text-main md:opacity-0 md:group-hover:opacity-100"
                title={t('persona.hide')}
                aria-label={t('persona.hide')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        {isLoading && (
          <p className="px-1 py-2 text-xs text-text-muted">{t('common.loading')}</p>
        )}
      </div>
    </div>
  );
}
