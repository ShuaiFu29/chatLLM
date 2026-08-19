import type { FormEvent, MouseEvent, RefObject } from 'react';
import type { TFunction } from 'i18next';
import {
  Archive,
  ArchiveRestore,
  Folder,
  MessageSquare,
  Pencil,
  Pin,
  StickyNote,
  Trash2,
} from 'lucide-react';
import type { Conversation } from '../stores/useChatStore';
import type { ProjectSpace } from '../stores/useProjectSpaceStore';

interface ConversationRowProps {
  conversation: Conversation;
  conversationFilter: 'active' | 'archived';
  editInputRef: RefObject<HTMLInputElement | null>;
  editTitle: string;
  isActive: boolean;
  isEditing: boolean;
  onArchive: (event: MouseEvent<HTMLButtonElement>, id: string) => void;
  onCancelEdit: () => void;
  onDelete: (event: MouseEvent<HTMLButtonElement>, id: string) => void;
  onEdit: (event: MouseEvent<HTMLButtonElement>, id: string, title: string) => void;
  onEditTitleChange: (title: string) => void;
  onRenameSubmit: (event?: FormEvent) => Promise<void>;
  onSelect: (id: string) => void;
  onTogglePin: (event: MouseEvent<HTMLButtonElement>, id: string) => void;
  onUnarchive: (event: MouseEvent<HTMLButtonElement>, id: string) => void;
  t: TFunction;
}

export function ConversationRow({
  conversation,
  conversationFilter,
  editInputRef,
  editTitle,
  isActive,
  isEditing,
  onArchive,
  onCancelEdit,
  onDelete,
  onEdit,
  onEditTitleChange,
  onRenameSubmit,
  onSelect,
  onTogglePin,
  onUnarchive,
  t,
}: ConversationRowProps) {
  const title = conversation.title === 'New Chat' ? t('sidebar.newChat') : conversation.title;

  return (
    <div
      className={`group relative flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors ${
        isActive
          ? 'bg-primary text-white shadow-sm'
          : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
      }`}
    >
      <MessageSquare className="h-4 w-4 shrink-0" />
      {conversation.is_pinned && conversationFilter === 'active' ? (
        <Pin className={`h-3 w-3 shrink-0 ${isActive ? 'text-white/80' : 'text-primary'}`} />
      ) : null}

      {isEditing ? (
        <form onSubmit={onRenameSubmit} className="flex min-w-0 flex-1 items-center gap-1">
          <input
            ref={editInputRef}
            type="text"
            value={editTitle}
            onChange={(event) => onEditTitleChange(event.target.value)}
            className="min-w-0 flex-1 rounded border border-primary bg-bg-base px-1 py-0.5 text-sm text-text-main outline-none"
            onClick={(event) => event.stopPropagation()}
            onBlur={() => void onRenameSubmit()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onCancelEdit();
                event.stopPropagation();
              }
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          data-testid={`conversation-${conversation.id}`}
          className="min-w-0 flex-1 cursor-pointer text-left"
          onClick={() => onSelect(conversation.id)}
        >
          <span className="block truncate text-sm">{title}</span>
          {((conversation.tags && conversation.tags.length > 0) || conversation.note) ? (
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {conversation.tags?.slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  className={`max-w-20 truncate rounded border px-1.5 py-0.5 text-[10px] ${
                    isActive ? 'border-white/25 text-white/80' : 'border-border text-text-muted'
                  }`}
                >
                  {tag}
                </span>
              ))}
              {conversation.note ? (
                <span
                  className={`inline-flex items-center rounded border px-1 py-0.5 ${
                    isActive ? 'border-white/25 text-white/80' : 'border-border text-text-muted'
                  }`}
                  title={`${t('chat.conversationNote')}: ${conversation.note}`}
                  aria-label={t('chat.conversationNote')}
                >
                  <StickyNote className="h-3 w-3" />
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      )}

      {!isEditing ? (
        <div className={`flex shrink-0 items-center gap-1 text-text-muted transition-opacity ${isActive ? 'text-white' : ''}`}>
          {conversationFilter === 'active' ? (
            <button
              onClick={(event) => onTogglePin(event, conversation.id)}
              className="rounded p-1 transition-colors hover:bg-white/20"
              title={conversation.is_pinned ? t('chat.unpinConversation') : t('chat.pinConversation')}
              aria-label={conversation.is_pinned ? t('chat.unpinConversation') : t('chat.pinConversation')}
            >
              <Pin className={`h-3 w-3 ${conversation.is_pinned ? 'fill-current' : ''}`} />
            </button>
          ) : null}
          <button
            onClick={(event) => onEdit(event, conversation.id, conversation.title)}
            className="rounded p-1 transition-colors hover:bg-white/20"
            title={t('common.edit')}
            aria-label={t('common.edit')}
          >
            <Pencil className="h-3 w-3" />
          </button>
          {conversationFilter === 'archived' ? (
            <button
              onClick={(event) => onUnarchive(event, conversation.id)}
              className="rounded p-1 transition-colors hover:bg-white/20"
              title={t('chat.unarchiveConversation')}
              aria-label={t('chat.unarchiveConversation')}
            >
              <ArchiveRestore className="h-3 w-3" />
            </button>
          ) : (
            <button
              onClick={(event) => onArchive(event, conversation.id)}
              className="rounded p-1 transition-colors hover:bg-white/20"
              title={t('chat.archiveConversation')}
              aria-label={t('chat.archiveConversation')}
            >
              <Archive className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={(event) => onDelete(event, conversation.id)}
            className="rounded p-1 transition-colors hover:bg-red-500/80 hover:text-white"
            title={t('common.delete')}
            aria-label={t('common.delete')}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface WorkspaceRowProps {
  conversationCount: number;
  isCurrent: boolean;
  onDelete: (event: MouseEvent<HTMLButtonElement>, id: string, name: string) => void;
  onRename: (event: MouseEvent<HTMLButtonElement>, id: string, name: string) => void;
  onSelect: (id: string) => void;
  space: ProjectSpace;
  t: TFunction;
}

export function WorkspaceRow({
  conversationCount,
  isCurrent,
  onDelete,
  onRename,
  onSelect,
  space,
  t,
}: WorkspaceRowProps) {
  return (
    <div
      className={`group flex items-center gap-3 rounded-xl border p-3 transition-colors ${
        isCurrent
          ? 'border-primary/50 bg-primary/10'
          : 'border-border bg-bg-base hover:border-primary/40 hover:bg-bg-surface'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(space.id)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-current={isCurrent ? 'true' : undefined}
      >
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${isCurrent ? 'bg-primary text-white' : 'bg-bg-surface text-primary'}`}>
          <Folder className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-main">{space.name}</span>
          <span className="mt-0.5 block truncate text-xs text-text-muted">
            {t('workspace.conversationCount', { count: conversationCount })}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {isCurrent ? (
            <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
              {t('workspace.currentBadge')}
            </span>
          ) : null}
          {space.is_default ? (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
              {t('workspace.defaultBadge')}
            </span>
          ) : null}
        </span>
      </button>

      {!space.is_default ? (
        <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
          <button
            onClick={(event) => onRename(event, space.id, space.name)}
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-sidebar hover:text-text-main"
            title={t('common.edit')}
            aria-label={t('common.edit')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(event) => onDelete(event, space.id, space.name)}
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-300"
            title={t('common.delete')}
            aria-label={t('common.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
