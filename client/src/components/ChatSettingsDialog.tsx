import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../stores/useChatStore';
import { AlertCircle, Save, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';
import api from '../lib/api';

interface ChatSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  description: string;
}

interface ProviderHealthItem {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  models: string[];
  'has_api_key': boolean;
  quota_status: 'unknown' | 'missing_key';
}

interface ProviderHealthResponse {
  default_provider: string;
  default_model: string;
  providers: ProviderHealthItem[];
}

export default function ChatSettingsDialog({ isOpen, onClose }: ChatSettingsDialogProps) {
  const { t } = useTranslation();
  const { currentConversationId, conversations, updateConversation } = useChatStore();
  const { projectSpaces, currentProjectSpaceId } = useProjectSpaceStore();
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [providerHealth, setProviderHealth] = useState<ProviderHealthResponse | null>(null);
  const [isLoadingPromptTemplates, setIsLoadingPromptTemplates] = useState(false);
  const [isLoadingProviderHealth, setIsLoadingProviderHealth] = useState(false);
  const [providerHealthError, setProviderHealthError] = useState<string | null>(null);

  const conversation = conversations.find(c => c.id === currentConversationId);

  const initialSettings = useMemo(() => ({
    model: conversation?.model || 'deepseek-chat',
    temperature: conversation?.temperature ?? 0.7,
    system_prompt: conversation?.system_prompt || 'You are a helpful AI assistant.',
    enable_rag: conversation?.enable_rag ?? true,
    project_space_id: conversation?.project_space_id || currentProjectSpaceId || '',
    tags: conversation?.tags || [],
    note: conversation?.note || '',
    promptTemplate: ''
  }), [conversation, currentProjectSpaceId]);

  const [draftSettings, setDraftSettings] = useState<typeof initialSettings | null>(null);

  const settings = draftSettings || initialSettings;

  const defaultSettings = {
    model: 'deepseek-chat',
    temperature: 0.7,
    system_prompt: 'You are a helpful AI assistant.',
    enable_rag: true,
    project_space_id: currentProjectSpaceId || '',
    tags: [],
    note: '',
    promptTemplate: ''
  };

  const isDirty = draftSettings !== null && (
    settings.model !== initialSettings.model ||
    settings.temperature !== initialSettings.temperature ||
    settings.system_prompt !== initialSettings.system_prompt ||
    settings.enable_rag !== initialSettings.enable_rag ||
    settings.project_space_id !== initialSettings.project_space_id ||
    settings.tags.join(',') !== initialSettings.tags.join(',') ||
    settings.note !== initialSettings.note
  );

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    const loadTimer = window.setTimeout(() => {
      setIsLoadingPromptTemplates(true);

      api.get<PromptTemplate[]>('/prompt-templates')
        .then((response) => {
          if (isMounted) setPromptTemplates(response.data);
        })
        .catch((error) => {
          console.error('Failed to load prompt templates:', error);
          if (isMounted) setPromptTemplates([]);
        })
        .finally(() => {
          if (isMounted) setIsLoadingPromptTemplates(false);
        });

      setIsLoadingProviderHealth(true);
      setProviderHealthError(null);
      api.get<ProviderHealthResponse>('/usage/provider-health')
        .then((response) => {
          if (isMounted) setProviderHealth(response.data);
        })
        .catch((error) => {
          console.error('Failed to load model provider health:', error);
          if (isMounted) {
            setProviderHealth(null);
            setProviderHealthError(t('settings.providerHealthLoadFailed'));
          }
        })
        .finally(() => {
          if (isMounted) setIsLoadingProviderHealth(false);
        });
    }, 0);

    return () => {
      isMounted = false;
      window.clearTimeout(loadTimer);
    };
  }, [isOpen, t]);

  const modelOptions = useMemo(() => {
    const options = providerHealth?.providers.flatMap((provider) => (
      provider.models.map((model) => ({
        model,
        provider,
        label: `${provider.name} · ${model}`,
      }))
    )) || [
      { model: 'deepseek-chat', provider: null, label: 'DeepSeek · deepseek-chat' },
      { model: 'deepseek-reasoner', provider: null, label: 'DeepSeek · deepseek-reasoner' },
      { model: 'qwen-plus', provider: null, label: 'Qwen · qwen-plus' },
    ];

    if (!options.some((option) => option.model === settings.model)) {
      return [
        { model: settings.model, provider: null, label: settings.model },
        ...options,
      ];
    }

    return options;
  }, [providerHealth, settings.model]);

  const selectedProviderHealth = useMemo(() => {
    return providerHealth?.providers.find((provider) => provider.models.includes(settings.model)) || null;
  }, [providerHealth, settings.model]);

  const isSelectedProviderUnavailable = Boolean(selectedProviderHealth && !selectedProviderHealth['has_api_key']);

  const handleChange = (newSettings: typeof settings) => {
    setDraftSettings(newSettings);
  };

  const handleTagsChange = (value: string) => {
    const tags = value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12);
    handleChange({ ...settings, tags });
  };

  const handleSave = async () => {
    if (currentConversationId) {
      await updateConversation(currentConversationId, {
        model: settings.model,
        temperature: settings.temperature,
        system_prompt: settings.system_prompt,
        enable_rag: settings.enable_rag,
        project_space_id: settings.project_space_id,
        tags: settings.tags,
        note: settings.note,
      });
    }
    setDraftSettings(null);
    onClose();
  };

  const handleClose = () => {
    setDraftSettings(null);
    onClose();
  };

  const handleReset = () => {
    setDraftSettings(defaultSettings);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-bg-sidebar border border-border rounded-xl w-full max-w-lg shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-main">{t('settings.title')}</h2>
          <button onClick={handleClose} className="text-text-muted hover:text-text-main">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto">

          {/* Model Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-main">{t('settings.model')}</label>
            <div className="relative">
              <select
                value={settings.model}
                onChange={(e) => handleChange({ ...settings, model: e.target.value })}
                className="w-full bg-bg-base text-text-main border border-border rounded-lg px-3 py-2 pr-8 focus:ring-2 focus:ring-primary focus:outline-none appearance-none"
              >
                {modelOptions.map((option) => (
                  <option
                    key={`${option.provider?.id || 'custom'}-${option.model}`}
                    value={option.model}
                    disabled={option.provider ? !option.provider['has_api_key'] : false}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-text-muted">
                <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                  <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
                </svg>
              </div>
            </div>
            <p className="text-xs text-text-muted">
              {t('settings.selectModel')}
            </p>
            <div className="rounded-lg border border-border bg-bg-base p-3 text-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium text-text-main">{t('settings.providerHealth')}</span>
                <span className="text-text-muted">
                  {isLoadingProviderHealth ? t('common.loading') : t('usage.quotaStatus')}
                </span>
              </div>
              {providerHealthError ? (
                <div className="flex items-start gap-2 text-red-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{providerHealthError}</span>
                </div>
              ) : selectedProviderHealth ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-border px-2 py-0.5 text-text-muted">
                    {selectedProviderHealth.name}
                  </span>
                  <span className={`rounded border px-2 py-0.5 ${
                    selectedProviderHealth['has_api_key']
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-red-500/30 bg-red-500/10 text-red-300'
                  }`}>
                    {selectedProviderHealth['has_api_key'] ? t('usage.configured') : t('usage.notConfigured')}
                  </span>
                  {isSelectedProviderUnavailable && (
                    <span className="text-red-300">{t('settings.providerUnavailable')}</span>
                  )}
                </div>
              ) : (
                <p className="text-text-muted">{t('settings.providerHealthLoadFailed')}</p>
              )}
            </div>
          </div>

          {/* Project Space */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-main">{t('settings.projectSpace')}</label>
            <select
              value={settings.project_space_id}
              onChange={(e) => handleChange({ ...settings, project_space_id: e.target.value })}
              className="w-full bg-bg-base text-text-main border border-border rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary focus:outline-none"
            >
              {projectSpaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </select>
          </div>

          {/* Prompt Template */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-main">{t('settings.promptTemplate')}</label>
            <select
              value={settings.promptTemplate}
              onChange={(e) => {
                const template = promptTemplates.find((item) => item.id === e.target.value);
                handleChange({
                  ...settings,
                  promptTemplate: e.target.value,
                  system_prompt: template?.content || settings.system_prompt,
                });
              }}
              className="w-full bg-bg-base text-text-main border border-border rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary focus:outline-none"
            >
              <option value="">{isLoadingPromptTemplates ? t('common.loading') : t('settings.noPromptTemplate')}</option>
              {promptTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-muted">{t('settings.promptTemplateHint')}</p>
          </div>

          {/* Temperature */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-text-main">{t('settings.temperature')}: {settings.temperature}</label>
              <span className="text-xs text-text-muted">
                {settings.temperature < 0.3 ? t('settings.temperatureHint.precise') : settings.temperature > 0.7 ? t('settings.temperatureHint.creative') : t('settings.temperatureHint.balanced')}
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={settings.temperature}
              onChange={(e) => handleChange({ ...settings, temperature: parseFloat(e.target.value) })}
              className="w-full h-2 bg-bg-base rounded-lg appearance-none cursor-pointer accent-primary"
            />
          </div>

          {/* System Prompt */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-main">{t('settings.systemPrompt')}</label>
            <textarea
              value={settings.system_prompt}
              onChange={(e) => handleChange({ ...settings, system_prompt: e.target.value })}
              className="w-full h-24 bg-bg-base text-text-main border border-border rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary focus:outline-none resize-none text-sm"
              placeholder={t('settings.systemPromptPlaceholder')}
            />
          </div>

          {/* Conversation Metadata */}
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-main">{t('settings.tags')}</label>
              <input
                value={settings.tags.join(', ')}
                onChange={(e) => handleTagsChange(e.target.value)}
                className="w-full bg-bg-base text-text-main border border-border rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary focus:outline-none text-sm"
                placeholder={t('settings.tagsPlaceholder')}
              />
              <p className="text-xs text-text-muted">{t('settings.tagsHint')}</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-main">{t('settings.note')}</label>
              <textarea
                value={settings.note}
                onChange={(e) => handleChange({ ...settings, note: e.target.value })}
                className="w-full h-20 bg-bg-base text-text-main border border-border rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary focus:outline-none resize-none text-sm"
                placeholder={t('settings.notePlaceholder')}
              />
            </div>
          </div>

          {/* Workspace Documents (RAG) */}
          <div className="flex items-center justify-between p-3 bg-bg-base rounded-lg border border-border">
            <div>
              <div className="text-sm font-medium text-text-main">{t('settings.enableRag')}</div>
              <div className="text-xs text-text-muted">{t('settings.enableRagHint')}</div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.enable_rag}
                onChange={(e) => handleChange({ ...settings, enable_rag: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-border peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-border bg-bg-surface/50 rounded-b-xl">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            {t('settings.reset')}
          </button>
          <div className="flex gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty || isSelectedProviderUnavailable}
              className={`flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors ${isDirty && !isSelectedProviderUnavailable
                ? 'bg-primary hover:bg-primary-hover text-white'
                : 'bg-bg-surface text-text-muted cursor-not-allowed border border-border'
                }`}
            >
              <Save className="w-4 h-4" />
              {t('settings.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
