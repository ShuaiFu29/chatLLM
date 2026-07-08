import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, Check, EyeOff, Lightbulb, RefreshCw, RotateCcw, Save, ShieldCheck, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import api from '../lib/api';

interface PersonaProfile {
  summary: string;
  role_label: string;
  goals: string[];
  preferences: string[];
  avoided_topics: string[];
  memory_enabled: boolean;
  updated_by_user_at?: string | null;
  analyzed_at?: string | null;
}

interface PersonaObservation {
  id: string;
  category: string;
  label: string;
  detail: string;
  confidence: number;
  evidence_count: number;
}

interface PersonaInterest {
  id: string;
  topic: string;
  score: number;
  trend: string;
  evidence_count: number;
}

interface PersonaSuggestion {
  id: string;
  topic: string;
  question: string;
  reason: string;
  confidence: number;
}

interface PersonaCenterResponse {
  profile: PersonaProfile;
  observations: PersonaObservation[];
  interests: PersonaInterest[];
  suggestions: PersonaSuggestion[];
}

interface EditableProfile {
  summary: string;
  role_label: string;
  goals: string;
  preferences: string;
  avoided_topics: string;
  memory_enabled: boolean;
}

const profileToEditState = (profile: PersonaProfile): EditableProfile => ({
  summary: profile.summary || '',
  role_label: profile.role_label || '',
  goals: profile.goals?.join('\n') || '',
  preferences: profile.preferences?.join('\n') || '',
  avoided_topics: profile.avoided_topics?.join('\n') || '',
  memory_enabled: profile.memory_enabled !== false,
});

const linesToArray = (value: string) => value
  .split(/\r?\n|,/)
  .map((item) => item.trim())
  .filter(Boolean)
  .slice(0, 12);

const formatPercent = (value: number) => `${Math.round((value || 0) * 100)}%`;

export default function PersonaCenter() {
  const { t } = useTranslation();
  const [center, setCenter] = useState<PersonaCenterResponse | null>(null);
  const [editedProfile, setEditedProfile] = useState<EditableProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const loadCenter = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.get<PersonaCenterResponse>('/persona');
      setCenter(res.data);
      setEditedProfile(profileToEditState(res.data.profile));
    } catch (error) {
      console.error('Failed to load persona center:', error);
      toast.error(t('persona.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadCenter();
  }, [loadCenter]);

  const hasInsights = useMemo(
    () => Boolean(center && (center.interests.length > 0 || center.suggestions.length > 0 || center.observations.length > 0)),
    [center]
  );

  const refreshInsights = async () => {
    setIsAnalyzing(true);
    try {
      const res = await api.post<PersonaCenterResponse>('/persona/analyze');
      setCenter(res.data);
      setEditedProfile(profileToEditState(res.data.profile));
      toast.success(t('persona.refreshSuccess'));
    } catch (error) {
      console.error('Failed to analyze persona center:', error);
      toast.error(t('persona.refreshFailed'));
    } finally {
      setIsAnalyzing(false);
    }
  };

  const saveProfile = async () => {
    if (!editedProfile) return;
    setIsSaving(true);
    try {
      const res = await api.patch<PersonaProfile>('/persona/profile', {
        summary: editedProfile.summary,
        role_label: editedProfile.role_label,
        goals: linesToArray(editedProfile.goals),
        preferences: linesToArray(editedProfile.preferences),
        avoided_topics: linesToArray(editedProfile.avoided_topics),
        memory_enabled: editedProfile.memory_enabled,
      });
      setCenter((current) => current ? { ...current, profile: res.data } : current);
      setEditedProfile(profileToEditState(res.data));
      toast.success(t('persona.saveSuccess'));
    } catch (error) {
      console.error('Failed to save persona profile:', error);
      toast.error(t('persona.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const setInterestStatus = async (interestId: string, status: 'accepted' | 'hidden') => {
    setCenter((current) => current
      ? { ...current, interests: current.interests.filter((interest) => interest.id !== interestId) }
      : current);
    try {
      await api.patch(`/persona/interests/${interestId}`, { status });
      toast.success(status === 'accepted' ? t('persona.accepted') : t('persona.hidden'));
    } catch (error) {
      console.error('Failed to update persona interest:', error);
      toast.error(t('persona.saveFailed'));
      void loadCenter();
    }
  };

  const setSuggestionStatus = async (suggestionId: string, status: 'hidden' | 'used') => {
    setCenter((current) => current
      ? { ...current, suggestions: current.suggestions.filter((suggestion) => suggestion.id !== suggestionId) }
      : current);
    try {
      await api.patch(`/persona/suggestions/${suggestionId}`, { status });
      toast.success(status === 'hidden' ? t('persona.hidden') : t('persona.accepted'));
    } catch (error) {
      console.error('Failed to update persona suggestion:', error);
      toast.error(t('persona.saveFailed'));
      void loadCenter();
    }
  };

  const resetProfile = async () => {
    setIsSaving(true);
    try {
      const res = await api.post<PersonaCenterResponse>('/persona/reset');
      setCenter(res.data);
      setEditedProfile(profileToEditState(res.data.profile));
      toast.success(t('persona.resetSuccess'));
    } catch (error) {
      console.error('Failed to reset persona center:', error);
      toast.error(t('persona.resetFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !editedProfile) {
    return (
      <div className="flex h-full items-center justify-center bg-bg-base text-sm text-text-muted">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-bg-base p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
              <Brain className="h-4 w-4" />
              {t('persona.centerLabel')}
            </div>
            <h1 className="text-2xl font-semibold text-text-main">{t('persona.title')}</h1>
            <p className="mt-1 max-w-3xl text-sm text-text-muted">{t('persona.subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refreshInsights}
              disabled={isAnalyzing}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-sidebar px-3 py-2 text-sm text-text-main transition-colors hover:bg-bg-surface disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${isAnalyzing ? 'animate-spin' : ''}`} />
              {t('persona.refreshInsights')}
            </button>
            <button
              type="button"
              onClick={saveProfile}
              disabled={isSaving}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
            >
              <Save className="h-4 w-4" />
              {t('common.save')}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-bg-sidebar p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <h2 className="text-sm font-semibold text-text-main">{t('persona.privacyTitle')}</h2>
              <p className="mt-1 text-sm leading-6 text-text-muted">{t('persona.privacyHint')}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <section className="space-y-4 rounded-xl border border-border bg-bg-sidebar p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text-main">{t('persona.editableProfile')}</h2>
                <p className="text-sm text-text-muted">{t('persona.editableProfileHint')}</p>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={editedProfile.memory_enabled}
                  onChange={(event) => setEditedProfile({ ...editedProfile, memory_enabled: event.target.checked })}
                  className="h-4 w-4 rounded border-border bg-bg-base accent-primary"
                />
                {t('persona.memoryEnabled')}
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium text-text-muted">{t('persona.roleLabel')}</span>
                <input
                  value={editedProfile.role_label}
                  onChange={(event) => setEditedProfile({ ...editedProfile, role_label: event.target.value })}
                  className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-text-muted">{t('persona.summaryLabel')}</span>
                <input
                  value={editedProfile.summary}
                  onChange={(event) => setEditedProfile({ ...editedProfile, summary: event.target.value })}
                  className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {[
                ['goals', t('persona.goalsLabel')],
                ['preferences', t('persona.preferencesLabel')],
                ['avoided_topics', t('persona.avoidedTopicsLabel')],
              ].map(([field, label]) => (
                <label key={field} className="space-y-1">
                  <span className="text-xs font-medium text-text-muted">{label}</span>
                  <textarea
                    value={editedProfile[field as keyof EditableProfile] as string}
                    onChange={(event) => setEditedProfile({ ...editedProfile, [field]: event.target.value })}
                    className="min-h-32 w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 text-sm leading-5 text-text-main outline-none focus:border-primary"
                  />
                </label>
              ))}
            </div>

            <div className="flex justify-between gap-3 border-t border-border pt-4">
              <button
                type="button"
                onClick={resetProfile}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main disabled:opacity-60"
              >
                <RotateCcw className="h-4 w-4" />
                {t('persona.resetProfile')}
              </button>
              <button
                type="button"
                onClick={saveProfile}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {t('common.save')}
              </button>
            </div>
          </section>

          <section className="space-y-4">
            <div className="rounded-xl border border-border bg-bg-sidebar p-4">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <h2 className="text-lg font-semibold text-text-main">{t('persona.inferredInterests')}</h2>
              </div>
              {center?.interests.length ? (
                <div className="space-y-2">
                  {center.interests.map((interest) => (
                    <div key={interest.id} className="rounded-lg border border-border bg-bg-base p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium text-text-main">{interest.topic}</p>
                          <p className="mt-1 text-xs text-text-muted">
                            {t('persona.evidenceCount', { count: interest.evidence_count })} · {formatPercent(interest.score)}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => void setInterestStatus(interest.id, 'accepted')}
                            className="rounded p-1.5 text-emerald-400 transition-colors hover:bg-emerald-500/10"
                            title={t('persona.accept')}
                            aria-label={t('persona.accept')}
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void setInterestStatus(interest.id, 'hidden')}
                            className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main"
                            title={t('persona.hide')}
                            aria-label={t('persona.hide')}
                          >
                            <EyeOff className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border bg-bg-base p-4 text-sm text-text-muted">
                  {hasInsights ? t('persona.noVisibleInterests') : t('persona.emptyState')}
                </p>
              )}
            </div>

            <div className="rounded-xl border border-border bg-bg-sidebar p-4">
              <div className="mb-3 flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-primary" />
                <h2 className="text-lg font-semibold text-text-main">{t('persona.likelyQuestions')}</h2>
              </div>
              {center?.suggestions.length ? (
                <div className="space-y-2">
                  {center.suggestions.map((suggestion) => (
                    <div key={suggestion.id} className="rounded-lg border border-border bg-bg-base p-3">
                      <p className="break-words text-sm font-medium text-text-main">{suggestion.question}</p>
                      <p className="mt-1 text-xs leading-5 text-text-muted">{suggestion.reason}</p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-text-muted">{suggestion.topic}</span>
                        <button
                          type="button"
                          onClick={() => void setSuggestionStatus(suggestion.id, 'hidden')}
                          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main"
                        >
                          <EyeOff className="h-3 w-3" />
                          {t('persona.hide')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border bg-bg-base p-4 text-sm text-text-muted">
                  {t('persona.noSuggestions')}
                </p>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-xl border border-border bg-bg-sidebar p-4">
          <h2 className="text-lg font-semibold text-text-main">{t('persona.observations')}</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {center?.observations.length ? center.observations.map((observation) => (
              <div key={observation.id} className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-sm font-medium text-text-main">{observation.label}</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">{observation.detail}</p>
                <p className="mt-2 text-[11px] text-text-muted">
                  {t('persona.evidenceCount', { count: observation.evidence_count })} · {formatPercent(observation.confidence)}
                </p>
              </div>
            )) : (
              <p className="rounded-lg border border-dashed border-border bg-bg-base p-4 text-sm text-text-muted md:col-span-2 xl:col-span-3">
                {t('persona.emptyState')}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
