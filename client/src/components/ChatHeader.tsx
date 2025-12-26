import { Sliders } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Conversation } from '../stores/useChatStore';

interface ChatHeaderProps {
  conversation?: Conversation;
  onOpenSettings: () => void;
}

export default function ChatHeader({ conversation, onOpenSettings }: ChatHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between p-3 md:p-4 border-b border-border bg-bg-base/80 backdrop-blur sticky top-0 z-10 shrink-0">
      <div className="flex items-center gap-2 overflow-hidden">
        <h2 className="font-semibold text-text-main truncate max-w-[200px] md:max-w-md">
          {conversation?.title || t('sidebar.newChat')}
        </h2>
        <span className={`text-[10px] md:text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${
          conversation?.model === 'deepseek-reasoner'
            ? 'bg-purple-500/10 text-purple-500 border-purple-500/20'
            : 'bg-primary/10 text-primary border-primary/20'
        }`}>
          {conversation?.model === 'deepseek-reasoner' ? 'DeepSeek-R1' : 'DeepSeek-V3'}
        </span>
      </div>
      <button
        onClick={onOpenSettings}
        className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface rounded-lg transition-colors"
        title={t('common.settings') || 'Settings'}
        aria-label={t('common.settings') || 'Settings'}
      >
        <Sliders className="w-5 h-5" />
      </button>
    </div>
  );
}
