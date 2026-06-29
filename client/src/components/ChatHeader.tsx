import { Download, GitCompare, Sliders, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type Conversation } from '../stores/useChatStore';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';

interface ChatHeaderProps {
  conversation?: Conversation;
  onOpenSettings: () => void;
  onExport: () => void;
  canExport: boolean;
  onToggleFavorite?: () => void;
  relatedConversations?: Conversation[];
  compareTargetId?: string;
  onCompareTargetChange?: (id: string) => void;
  onCompare?: () => void;
}

export default function ChatHeader({
  conversation,
  onOpenSettings,
  onExport,
  canExport,
  onToggleFavorite,
  relatedConversations = [],
  compareTargetId = '',
  onCompareTargetChange,
  onCompare,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const { projectSpaces } = useProjectSpaceStore();
  const projectSpace = projectSpaces.find((space) => space.id === conversation?.project_space_id);

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
        {projectSpace && (
          <span className="hidden sm:inline text-[10px] md:text-xs px-2 py-0.5 rounded-full border border-border text-text-muted whitespace-nowrap">
            {projectSpace.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {conversation && relatedConversations.length > 0 && (
          <div className="hidden items-center gap-1 lg:flex">
            <select
              value={compareTargetId}
              onChange={(event) => onCompareTargetChange?.(event.target.value)}
              className="h-9 max-w-44 rounded-lg border border-border bg-bg-surface px-2 text-xs text-text-main outline-none focus:border-primary"
              aria-label={t('chat.compareVersions')}
            >
              {relatedConversations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title === 'New Chat' ? t('sidebar.newChat') : item.title}
                </option>
              ))}
            </select>
            <button
              onClick={onCompare}
              disabled={!compareTargetId}
              className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              title={t('chat.compareVersions')}
              aria-label={t('chat.compareVersions')}
            >
              <GitCompare className="w-5 h-5" />
            </button>
          </div>
        )}
        {conversation && (
          <button
            onClick={onToggleFavorite}
            className="p-2 text-text-muted hover:text-yellow-300 hover:bg-bg-surface rounded-lg transition-colors"
            title={conversation.is_favorite ? t('chat.unfavoriteConversation') : t('chat.favoriteConversation')}
            aria-label={conversation.is_favorite ? t('chat.unfavoriteConversation') : t('chat.favoriteConversation')}
          >
            <Star className={`w-5 h-5 ${conversation.is_favorite ? 'fill-yellow-300 text-yellow-300' : ''}`} />
          </button>
        )}
        <button
          onClick={onExport}
          disabled={!canExport}
          className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          title={t('chat.exportMarkdown')}
          aria-label={t('chat.exportMarkdown')}
        >
          <Download className="w-5 h-5" />
        </button>
        <button
          onClick={onOpenSettings}
          className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface rounded-lg transition-colors"
          title={t('common.settings')}
          aria-label={t('common.settings')}
        >
          <Sliders className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
