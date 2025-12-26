import { useState, useEffect } from 'react';
import { useChatStore } from '../stores/useChatStore';
import { X, Save, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ChatSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function ChatSettingsDialog({ isOpen, onClose }: ChatSettingsDialogProps) {
  const { t } = useTranslation();
  const { currentConversationId, conversations, updateConversation } = useChatStore();

  const conversation = conversations.find(c => c.id === currentConversationId);

  const [settings, setSettings] = useState({
    model: 'deepseek-chat',
    temperature: 0.7,
    system_prompt: 'You are a helpful AI assistant.',
    enable_rag: true
  });

  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (conversation) {
      setSettings({
        model: conversation.model || 'deepseek-chat',
        temperature: conversation.temperature ?? 0.7,
        system_prompt: conversation.system_prompt || 'You are a helpful AI assistant.',
        enable_rag: conversation.enable_rag ?? true
      });
      setIsDirty(false);
    }
  }, [conversation, isOpen]);

  const handleChange = (newSettings: typeof settings) => {
    setSettings(newSettings);
    // Compare with initial state
    if (conversation) {
      const isChanged =
        newSettings.model !== (conversation.model || 'deepseek-chat') ||
        newSettings.temperature !== (conversation.temperature ?? 0.7) ||
        newSettings.system_prompt !== (conversation.system_prompt || 'You are a helpful AI assistant.') ||
        newSettings.enable_rag !== (conversation.enable_rag ?? true);
      setIsDirty(isChanged);
    } else {
      setIsDirty(true);
    }
  };

  const handleSave = async () => {
    if (currentConversationId) {
      await updateConversation(currentConversationId, settings);
    }
    onClose();
  };

  const handleReset = () => {
    const defaultSettings = {
      model: 'deepseek-chat',
      temperature: 0.7,
      system_prompt: 'You are a helpful AI assistant.',
      enable_rag: true
    };
    setSettings(defaultSettings);
    handleChange(defaultSettings);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-bg-sidebar border border-border rounded-xl w-full max-w-lg shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-main">{t('settings.title')}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-main">
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
                <option value="deepseek-chat">DeepSeek-V3 (Fast & General)</option>
                <option value="deepseek-reasoner">DeepSeek-R1 (Reasoning & Coding)</option>
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

          {/* Knowledge Base (RAG) */}
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
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty}
              className={`flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors ${isDirty
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
