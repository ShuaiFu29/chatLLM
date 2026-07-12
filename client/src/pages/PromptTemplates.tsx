import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, BookOpenText, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';
import Modal from '../components/Modal';
import SelectField from '../components/SelectField';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';

interface PromptTemplate {
  id: string;
  project_space_id?: string | null;
  name: string;
  content: string;
  description: string;
  is_default: boolean;
  updated_at: string;
}

interface PromptTemplateDraft {
  project_space_id: string;
  name: string;
  content: string;
  description: string;
  is_default: boolean;
}

type TemplateModalMode = 'view' | 'edit' | 'create' | null;

const emptyDraft: PromptTemplateDraft = {
  project_space_id: '',
  name: '',
  content: '',
  description: '',
  is_default: false,
};

const createDraftFromTemplate = (template: PromptTemplate): PromptTemplateDraft => ({
  project_space_id: template.project_space_id || '',
  name: template.name,
  content: template.content,
  description: template.description || '',
  is_default: template.is_default,
});

export default function PromptTemplatesPage() {
  const { t } = useTranslation();
  const { projectSpaces, fetchProjectSpaces } = useProjectSpaceStore();
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateModalMode, setTemplateModalMode] = useState<TemplateModalMode>(null);
  const [draft, setDraft] = useState<PromptTemplateDraft>(emptyDraft);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) || null,
    [selectedTemplateId, templates]
  );

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { data } = await api.get<PromptTemplate[]>('/prompt-templates');
      setTemplates(data);
    } catch (fetchError) {
      console.error('Failed to load prompt templates:', toSafeError(fetchError));
      setError(t('prompts.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchProjectSpaces();
    void fetchTemplates();
  }, [fetchProjectSpaces, fetchTemplates]);

  const getScopeLabel = (projectSpaceId?: string | null) => {
    if (!projectSpaceId) return t('prompts.globalScope');
    return projectSpaces.find((space) => space.id === projectSpaceId)?.name || t('workspace.fallbackName');
  };

  const openTemplateView = (template: PromptTemplate) => {
    setSelectedTemplateId(template.id);
    setDraft(createDraftFromTemplate(template));
    setError(null);
    setTemplateModalMode('view');
  };

  const openTemplateEditor = (template: PromptTemplate) => {
    setSelectedTemplateId(template.id);
    setDraft(createDraftFromTemplate(template));
    setError(null);
    setTemplateModalMode('edit');
  };

  const handleNewTemplate = () => {
    setSelectedTemplateId(null);
    setDraft(emptyDraft);
    setError(null);
    setTemplateModalMode('create');
  };

  const closeTemplateModal = () => {
    if (isSaving) return;
    setTemplateModalMode(null);
    setError(null);
  };

  const handleSaveTemplate = async () => {
    const name = draft.name.trim();
    const content = draft.content.trim();

    if (!name || !content) {
      setError(t('prompts.validationRequired'));
      return;
    }

    setIsSaving(true);
    setError(null);

    const payload = {
      project_space_id: draft.project_space_id || null,
      name,
      content,
      description: draft.description.trim(),
      is_default: draft.is_default,
    };

    try {
      if (selectedTemplateId && templateModalMode === 'edit') {
        const { data } = await api.patch<PromptTemplate>(`/prompt-templates/${selectedTemplateId}`, payload);
        setTemplates((currentTemplates) => currentTemplates.map((template) => (
          template.id === data.id ? data : template
        )));
        setSelectedTemplateId(data.id);
      } else {
        const { data } = await api.post<PromptTemplate>('/prompt-templates', payload);
        setTemplates((currentTemplates) => [data, ...currentTemplates]);
        setSelectedTemplateId(data.id);
      }
      setTemplateModalMode('view');
    } catch (saveError) {
      console.error('Failed to save prompt template:', toSafeError(saveError));
      setError(t('prompts.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplateId) return;

    setIsSaving(true);
    setError(null);

    try {
      await api.delete(`/prompt-templates/${selectedTemplateId}`);
      setTemplates((currentTemplates) => currentTemplates.filter((template) => template.id !== selectedTemplateId));
      setSelectedTemplateId(null);
      setDraft(emptyDraft);
      setTemplateModalMode(null);
    } catch (deleteError) {
      console.error('Failed to delete prompt template:', toSafeError(deleteError));
      setError(t('prompts.deleteFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const isEditing = templateModalMode === 'edit' || templateModalMode === 'create';

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-main">
      <div className="border-b border-border bg-bg-sidebar p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <BookOpenText className="h-5 w-5 text-primary" />
              {t('prompts.title')}
            </h1>
            <p className="mt-1 text-sm text-text-muted">{t('prompts.subtitle')}</p>
          </div>
          <button
            onClick={handleNewTemplate}
            className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            <Plus className="h-4 w-4" />
            {t('prompts.newTemplate')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <section className="mx-auto max-w-6xl rounded-lg border border-border bg-bg-sidebar">
          <div className="flex items-center justify-between gap-3 border-b border-border p-4">
            <div>
              <h2 className="font-semibold">{t('prompts.library')}</h2>
              <p className="mt-1 text-xs text-text-muted">{t('prompts.detailsHint')}</p>
            </div>
          </div>

          {error && !templateModalMode && (
            <div className="m-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center gap-2 p-12 text-sm text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-12 text-center text-text-muted">
              <BookOpenText className="h-10 w-10 opacity-30" />
              <p>{t('prompts.empty')}</p>
              <button
                onClick={handleNewTemplate}
                className="rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
              >
                {t('prompts.newTemplate')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
              {templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => openTemplateView(template)}
                  className="min-h-36 rounded-lg border border-border bg-bg-base p-4 text-left transition-colors hover:border-primary/60 hover:bg-bg-surface"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold text-text-main">{template.name}</span>
                    {template.is_default && (
                      <span className="shrink-0 rounded border border-primary/30 px-1.5 py-0.5 text-[10px] text-primary">
                        {t('prompts.defaultBadge')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted">{getScopeLabel(template.project_space_id)}</p>
                  {template.description && (
                    <p className="mt-3 line-clamp-2 text-xs leading-5 text-text-muted">{template.description}</p>
                  )}
                  <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words border-t border-border pt-3 font-mono text-xs leading-5 text-text-muted">
                    {template.content}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <Modal
        isOpen={templateModalMode === 'view' && !!selectedTemplate}
        onClose={closeTemplateModal}
        title={selectedTemplate?.name || t('prompts.viewTemplate')}
        maxWidth="2xl"
        footer={
          <>
            <button
              onClick={handleDeleteTemplate}
              disabled={isSaving}
              className="flex items-center justify-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {t('prompts.delete')}
            </button>
            {selectedTemplate && (
              <button
                onClick={() => openTemplateEditor(selectedTemplate)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:text-text-main"
              >
                {t('common.edit')}
              </button>
            )}
            <button
              onClick={closeTemplateModal}
              className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
            >
              {t('common.close')}
            </button>
          </>
        }
      >
        {selectedTemplate && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('prompts.workspaceScope')}</p>
                <p className="mt-1 text-text-main">{getScopeLabel(selectedTemplate.project_space_id)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg-base p-3">
                <p className="text-xs text-text-muted">{t('prompts.defaultBadge')}</p>
                <p className="mt-1 text-text-main">{selectedTemplate.is_default ? t('common.yes') : t('common.no')}</p>
              </div>
            </div>
            {selectedTemplate.description && (
              <div>
                <p className="mb-1 text-xs font-medium text-text-muted">{t('prompts.description')}</p>
                <p className="rounded-lg border border-border bg-bg-base p-3 text-sm">{selectedTemplate.description}</p>
              </div>
            )}
            <div>
              <p className="mb-1 text-xs font-medium text-text-muted">{t('prompts.content')}</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-base p-3 font-mono text-xs leading-6 text-text-main">
                {selectedTemplate.content}
              </pre>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isEditing}
        onClose={closeTemplateModal}
        title={templateModalMode === 'create' ? t('prompts.createTemplate') : t('prompts.editTemplate')}
        maxWidth="2xl"
        footer={
          <>
            <button
              onClick={closeTemplateModal}
              disabled={isSaving}
              className="rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSaveTemplate}
              disabled={isSaving}
              className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t('prompts.save')}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('prompts.name')}</label>
              <input
                value={draft.name}
                maxLength={120}
                onChange={(event) => setDraft((currentDraft) => ({ ...currentDraft, name: event.target.value }))}
                className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                placeholder={t('prompts.namePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('prompts.workspaceScope')}</label>
              <SelectField
                value={draft.project_space_id}
                onChange={(event) => setDraft((currentDraft) => ({ ...currentDraft, project_space_id: event.target.value }))}
                className="w-full"
              >
                <option value="">{t('prompts.globalScope')}</option>
                {projectSpaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </SelectField>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('prompts.description')}</label>
            <input
              value={draft.description}
              maxLength={500}
              onChange={(event) => setDraft((currentDraft) => ({ ...currentDraft, description: event.target.value }))}
              className="w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
              placeholder={t('prompts.descriptionPlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('prompts.content')}</label>
            <textarea
              value={draft.content}
              maxLength={8000}
              onChange={(event) => setDraft((currentDraft) => ({ ...currentDraft, content: event.target.value }))}
              className="min-h-48 w-full resize-y rounded-lg border border-border bg-bg-base px-3 py-2 font-mono text-sm leading-6 outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
              placeholder={t('prompts.contentPlaceholder')}
            />
            <p className="text-xs text-text-muted">{draft.content.length}/8000</p>
          </div>

          <label className="flex items-center gap-2 rounded-lg border border-border bg-bg-base p-3 text-sm">
            <input
              type="checkbox"
              checked={draft.is_default}
              onChange={(event) => setDraft((currentDraft) => ({ ...currentDraft, is_default: event.target.checked }))}
              className="h-4 w-4 accent-primary"
            />
            <span>{t('prompts.markDefault')}</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}
