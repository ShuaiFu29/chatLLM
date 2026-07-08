import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatStore, type Conversation } from '../stores/useChatStore';
import { MessageSquare, Plus, LogOut, FileText, Trash2, Pencil, Menu, X, Search, Folder, FolderPlus, BarChart3, Pin, Archive, ArchiveRestore, BookOpenText, StickyNote, ClipboardCheck, Route, Network, UserRound } from 'lucide-react';
import api from '../lib/api';
import Modal from '../components/Modal';
import SearchDialog from '../components/SearchDialog';
import { useSearchStore } from '../stores/useSearchStore';
import { useProjectSpaceStore, type ProjectSpace } from '../stores/useProjectSpaceStore';
import { getAvatarUrl } from '../lib/avatar';

export default function MainLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { setIsOpen: setSearchOpen } = useSearchStore();
  const {
    projectSpaces,
    currentProjectSpaceId,
    fetchProjectSpaces,
    createProjectSpace,
    renameProjectSpace,
    deleteProjectSpace,
    selectProjectSpace,
  } = useProjectSpaceStore();
  const {
    conversations,
    currentConversationId,
    fetchConversations,
    createConversation,
    deleteConversation,
    renameConversation,
    toggleConversationPinned,
    archiveConversation,
    unarchiveConversation,
    selectConversation,
  } = useChatStore();

  const [knowledgeFiles, setKnowledgeFiles] = useState<{ filename: string; uploaded_at: string }[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Mobile Sidebar State
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Workspace creation state
  const [isCreateProjectSpaceOpen, setIsCreateProjectSpaceOpen] = useState(false);
  const [newProjectSpaceName, setNewProjectSpaceName] = useState('');
  const [createProjectSpaceError, setCreateProjectSpaceError] = useState<string | null>(null);
  const [isCreatingProjectSpace, setIsCreatingProjectSpace] = useState(false);
  const createProjectSpaceInputRef = useRef<HTMLInputElement>(null);

  const [renamingProjectSpaceId, setRenamingProjectSpaceId] = useState<string | null>(null);
  const [renamingProjectSpaceName, setRenamingProjectSpaceName] = useState('');
  const [renameProjectSpaceError, setRenameProjectSpaceError] = useState<string | null>(null);
  const [isRenamingProjectSpace, setIsRenamingProjectSpace] = useState(false);
  const renameProjectSpaceInputRef = useRef<HTMLInputElement>(null);

  const [deleteProjectSpaceTarget, setDeleteProjectSpaceTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteProjectSpaceError, setDeleteProjectSpaceError] = useState<string | null>(null);
  const [isDeletingProjectSpace, setIsDeletingProjectSpace] = useState(false);
  const [conversationFilter, setConversationFilter] = useState<'active' | 'archived'>('active');
  const [isWorkspaceBrowserOpen, setIsWorkspaceBrowserOpen] = useState(false);
  const [isConversationBrowserOpen, setIsConversationBrowserOpen] = useState(false);

  const baseProjectConversations = useMemo(
    () => conversations
      .filter((conv) => conv.project_space_id === currentProjectSpaceId)
      .filter((conv) => conversationFilter === 'archived' ? !!conv.archived_at : !conv.archived_at),
    [conversations, conversationFilter, currentProjectSpaceId]
  );

  const currentProjectConversations = useMemo(
    () => baseProjectConversations
      .slice()
      .sort((a, b) => {
        const pinnedDelta = Number(b.is_pinned || false) - Number(a.is_pinned || false);
        if (pinnedDelta !== 0) return pinnedDelta;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      }),
    [baseProjectConversations]
  );

  const spaceConversationCounts = useMemo(() => {
    const counts = new Map<string | null | undefined, number>();
    conversations.forEach((conv) => {
      counts.set(conv.project_space_id, (counts.get(conv.project_space_id) || 0) + 1);
    });
    return counts;
  }, [conversations]);
  const currentWorkspaceTotalConversations = spaceConversationCounts.get(currentProjectSpaceId) || 0;

  const currentProjectSpace = projectSpaces.find((space) => space.id === currentProjectSpaceId);
  const currentWorkspaceName = currentProjectSpace?.name || t('workspace.fallbackName');
  const userDisplayName = user?.display_name || user?.username || 'User';
  const userAvatarUrl = getAvatarUrl(user?.avatar_url, userDisplayName, 64);

  const fetchKnowledgeFiles = useCallback(async () => {
    try {
      const res = await api.get('/upload/files', {
        params: { projectSpaceId: currentProjectSpaceId || undefined }
      });
      setKnowledgeFiles(res.data);
    } catch (err) {
      console.error('Failed to fetch knowledge files:', err);
    }
  }, [currentProjectSpaceId]);

  useEffect(() => {
    const initData = async () => {
      await fetchProjectSpaces();
      await fetchConversations({ includeArchived: true });
    };
    initData();
  }, [fetchConversations, fetchProjectSpaces]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchKnowledgeFiles());

    const handleKnowledgeUpdate = () => {
      fetchKnowledgeFiles();
    };
    window.addEventListener('knowledge-updated', handleKnowledgeUpdate);

    return () => {
      window.removeEventListener('knowledge-updated', handleKnowledgeUpdate);
    };
  }, [currentProjectSpaceId, fetchKnowledgeFiles]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
    }
  }, [editingId]);

  useEffect(() => {
    if (!isCreateProjectSpaceOpen) return;

    const focusTimer = window.setTimeout(() => {
      createProjectSpaceInputRef.current?.focus();
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [isCreateProjectSpaceOpen]);

  useEffect(() => {
    if (!renamingProjectSpaceId) return;

    const focusTimer = window.setTimeout(() => {
      renameProjectSpaceInputRef.current?.focus();
      renameProjectSpaceInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [renamingProjectSpaceId]);

  const handleSelectConversation = (id: string) => {
    if (editingId) return; // Prevent selection while editing
    selectConversation(id);
    navigate('/');
    setIsConversationBrowserOpen(false);
    setIsMobileMenuOpen(false); // Close sidebar on mobile
  };

  const handleNewChat = async () => {
    setConversationFilter('active');
    await createConversation(undefined, { project_space_id: currentProjectSpaceId });
    navigate('/');
    setIsMobileMenuOpen(false); // Close sidebar on mobile
  };

  const handleOpenCreateProjectSpace = () => {
    setNewProjectSpaceName('');
    setCreateProjectSpaceError(null);
    setIsWorkspaceBrowserOpen(false);
    setIsCreateProjectSpaceOpen(true);
  };

  const handleCreateProjectSpace = async (e?: React.FormEvent) => {
    e?.preventDefault();

    const trimmedName = newProjectSpaceName.trim();
    if (!trimmedName) {
      setCreateProjectSpaceError(t('workspace.nameRequired'));
      return;
    }

    setIsCreatingProjectSpace(true);
    setCreateProjectSpaceError(null);

    try {
      await createProjectSpace(trimmedName);
      await fetchConversations({ includeArchived: true });
      setIsCreateProjectSpaceOpen(false);
      navigate('/knowledge');
      setIsMobileMenuOpen(false);
    } catch (error) {
      console.error('Failed to create workspace:', error);
      setCreateProjectSpaceError(t('workspace.createFailed'));
    } finally {
      setIsCreatingProjectSpace(false);
    }
  };

  const handleSelectProjectSpace = (id: string) => {
    selectProjectSpace(id);
    setIsWorkspaceBrowserOpen(false);
    setIsMobileMenuOpen(false);
  };

  const handleOpenRenameProjectSpace = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setIsWorkspaceBrowserOpen(false);
    setRenamingProjectSpaceId(id);
    setRenamingProjectSpaceName(name);
    setRenameProjectSpaceError(null);
  };

  const handleRenameProjectSpace = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!renamingProjectSpaceId) return;

    const trimmedName = renamingProjectSpaceName.trim();
    if (!trimmedName) {
      setRenameProjectSpaceError(t('workspace.nameRequired'));
      return;
    }

    setIsRenamingProjectSpace(true);
    setRenameProjectSpaceError(null);

    try {
      await renameProjectSpace(renamingProjectSpaceId, trimmedName);
      setRenamingProjectSpaceId(null);
    } catch (error) {
      console.error('Failed to rename workspace:', error);
      setRenameProjectSpaceError(t('workspace.renameFailed'));
    } finally {
      setIsRenamingProjectSpace(false);
    }
  };

  const handleOpenDeleteProjectSpace = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setIsWorkspaceBrowserOpen(false);
    setDeleteProjectSpaceTarget({ id, name });
    setDeleteProjectSpaceError(null);
  };

  const confirmDeleteProjectSpace = async () => {
    if (!deleteProjectSpaceTarget) return;

    const isCurrentProjectSpace = deleteProjectSpaceTarget.id === currentProjectSpaceId;
    setIsDeletingProjectSpace(true);
    setDeleteProjectSpaceError(null);

    try {
      await deleteProjectSpace(deleteProjectSpaceTarget.id);
      await fetchConversations({ includeArchived: true });
      setDeleteProjectSpaceTarget(null);
      window.dispatchEvent(new Event('knowledge-updated'));
      if (isCurrentProjectSpace) {
        navigate('/knowledge');
      }
    } catch (error) {
      console.error('Failed to delete workspace:', error);
      setDeleteProjectSpaceError(t('workspace.deleteFailed'));
    } finally {
      setIsDeletingProjectSpace(false);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeleteId(id);
  };

  const handleEditClick = (e: React.MouseEvent, id: string, currentTitle: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditTitle(currentTitle);
  };

  const handleTogglePinClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    toggleConversationPinned(id);
  };

  const handleArchiveClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    archiveConversation(id);
  };

  const handleUnarchiveClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    unarchiveConversation(id);
  };

  const handleRenameSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (editingId && editTitle.trim()) {
      await renameConversation(editingId, editTitle.trim());
      setEditingId(null);
    } else {
      setEditingId(null);
    }
  };

  const confirmDelete = () => {
    if (deleteId) {
      setDeleteId(null); // Close immediately for snappy UX
      deleteConversation(deleteId);
    }
  };

  const isKnowledgePage = location.pathname === '/knowledge';
  const isUsagePage = location.pathname === '/usage';
  const isPromptsPage = location.pathname === '/prompts';
  const isPersonaPage = location.pathname === '/persona';
  const isRagEvalPage = location.pathname === '/rag-eval';
  const isRetrievalLabPage = location.pathname === '/retrieval-lab';
  const isGraphExplorerPage = location.pathname === '/rag-graph';

  useEffect(() => {
    // Also support clicking on the search trigger
    const handleSearchClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-search-trigger]')) {
        setSearchOpen(true);
      }
    };
    document.addEventListener('click', handleSearchClick);
    return () => document.removeEventListener('click', handleSearchClick);
  }, [setSearchOpen]);

  const getConversationTitle = (conv: Conversation) => (
    conv.title === 'New Chat' ? t('sidebar.newChat') : conv.title
  );

  const renderConversationRow = (conv: Conversation, mode: 'sidebar' | 'modal') => {
    const isActive = currentConversationId === conv.id && !isKnowledgePage && location.pathname === '/';
    const actionVisibility = mode === 'modal'
      ? 'flex opacity-100'
      : 'hidden md:flex md:opacity-0 md:group-hover:opacity-100';

    return (
      <div
        key={conv.id}
        className={`group relative flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors ${
          isActive
            ? 'bg-primary text-white shadow-sm'
            : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
        }`}
      >
        <MessageSquare className="h-4 w-4 shrink-0" />
        {conv.is_pinned && conversationFilter === 'active' && (
          <Pin className={`h-3 w-3 shrink-0 ${isActive ? 'text-white/80' : 'text-primary'}`} />
        )}

        {editingId === conv.id ? (
          <form onSubmit={handleRenameSubmit} className="flex min-w-0 flex-1 items-center gap-1">
            <input
              ref={editInputRef}
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="min-w-0 flex-1 rounded border border-primary bg-bg-base px-1 py-0.5 text-sm text-text-main outline-none"
              onClick={(e) => e.stopPropagation()}
              onBlur={() => handleRenameSubmit()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditingId(null);
                  e.stopPropagation();
                }
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer text-left"
            onClick={() => handleSelectConversation(conv.id)}
          >
            <span className="block truncate text-sm">
              {getConversationTitle(conv)}
            </span>
            {((conv.tags && conv.tags.length > 0) || conv.note) && (
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                {conv.tags?.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className={`max-w-20 truncate rounded border px-1.5 py-0.5 text-[10px] ${
                      isActive
                        ? 'border-white/25 text-white/80'
                        : 'border-border text-text-muted'
                    }`}
                  >
                    {tag}
                  </span>
                ))}
                {conv.note && (
                  <span
                    className={`inline-flex items-center rounded border px-1 py-0.5 ${
                      isActive
                        ? 'border-white/25 text-white/80'
                        : 'border-border text-text-muted'
                    }`}
                    title={`${t('chat.conversationNote')}: ${conv.note}`}
                    aria-label={t('chat.conversationNote')}
                  >
                    <StickyNote className="h-3 w-3" />
                  </span>
                )}
              </span>
            )}
          </button>
        )}

        {!editingId && (
          <div className={`${actionVisibility} shrink-0 items-center gap-1 transition-opacity ${isActive ? 'text-white' : 'text-text-muted'}`}>
            {conversationFilter === 'active' && (
              <button
                onClick={(e) => handleTogglePinClick(e, conv.id)}
                className="rounded p-1 transition-colors hover:bg-white/20"
                title={conv.is_pinned ? t('chat.unpinConversation') : t('chat.pinConversation')}
                aria-label={conv.is_pinned ? t('chat.unpinConversation') : t('chat.pinConversation')}
              >
                <Pin className={`h-3 w-3 ${conv.is_pinned ? 'fill-current' : ''}`} />
              </button>
            )}
            <button
              onClick={(e) => handleEditClick(e, conv.id, conv.title)}
              className="rounded p-1 transition-colors hover:bg-white/20"
              title={t('common.edit')}
              aria-label={t('common.edit')}
            >
              <Pencil className="h-3 w-3" />
            </button>
            {conversationFilter === 'archived' ? (
              <button
                onClick={(e) => handleUnarchiveClick(e, conv.id)}
                className="rounded p-1 transition-colors hover:bg-white/20"
                title={t('chat.unarchiveConversation')}
                aria-label={t('chat.unarchiveConversation')}
              >
                <ArchiveRestore className="h-3 w-3" />
              </button>
            ) : (
              <button
                onClick={(e) => handleArchiveClick(e, conv.id)}
                className="rounded p-1 transition-colors hover:bg-white/20"
                title={t('chat.archiveConversation')}
                aria-label={t('chat.archiveConversation')}
              >
                <Archive className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={(e) => handleDeleteClick(e, conv.id)}
              className="rounded p-1 transition-colors hover:bg-red-500/80 hover:text-white"
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderWorkspaceRow = (space: ProjectSpace) => {
    const isCurrent = space.id === currentProjectSpaceId;
    const conversationCount = spaceConversationCounts.get(space.id) || 0;

    return (
      <div
        key={space.id}
        className={`group flex items-center gap-3 rounded-xl border p-3 transition-colors ${
          isCurrent
            ? 'border-primary/50 bg-primary/10'
            : 'border-border bg-bg-base hover:border-primary/40 hover:bg-bg-surface'
        }`}
      >
        <button
          type="button"
          onClick={() => handleSelectProjectSpace(space.id)}
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
            {isCurrent && (
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                {t('workspace.currentBadge')}
              </span>
            )}
            {space.is_default && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                {t('workspace.defaultBadge')}
              </span>
            )}
          </span>
        </button>

        {!space.is_default && (
          <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
            <button
              onClick={(e) => handleOpenRenameProjectSpace(e, space.id, space.name)}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-sidebar hover:text-text-main"
              title={t('common.edit')}
              aria-label={t('common.edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => handleOpenDeleteProjectSpace(e, space.id, space.name)}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-300"
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-bg-base text-text-main transition-colors duration-300">
      <SearchDialog />
      <Modal
        isOpen={isCreateProjectSpaceOpen}
        onClose={() => {
          if (!isCreatingProjectSpace) {
            setIsCreateProjectSpaceOpen(false);
          }
        }}
        title={t('workspace.createTitle')}
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsCreateProjectSpaceOpen(false)}
              disabled={isCreatingProjectSpace}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              form="create-project-space-form"
              disabled={isCreatingProjectSpace || !newProjectSpaceName.trim()}
              className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreatingProjectSpace ? t('common.saving') : t('workspace.createAction')}
            </button>
          </>
        }
      >
        <form id="create-project-space-form" onSubmit={handleCreateProjectSpace} className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-bg-surface/40 p-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
              <FolderPlus className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-text-main">{t('workspace.createDescription')}</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('workspace.createScopeHint')}</p>
            </div>
          </div>

          <div>
            <label htmlFor="project-space-name" className="mb-2 block text-sm font-medium text-text-main">
              {t('workspace.nameLabel')}
            </label>
            <input
              id="project-space-name"
              ref={createProjectSpaceInputRef}
              type="text"
              value={newProjectSpaceName}
              maxLength={80}
              onChange={(event) => {
                setNewProjectSpaceName(event.target.value);
                if (createProjectSpaceError) setCreateProjectSpaceError(null);
              }}
              placeholder={t('workspace.namePlaceholder')}
              aria-invalid={!!createProjectSpaceError}
              className="w-full rounded-lg border border-border bg-bg-base px-3 py-2.5 text-sm text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
              <p className={createProjectSpaceError ? 'text-red-400' : 'text-text-muted'}>
                {createProjectSpaceError || t('workspace.nameHint')}
              </p>
              <span className="shrink-0 text-text-muted">{newProjectSpaceName.trim().length}/80</span>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!renamingProjectSpaceId}
        onClose={() => {
          if (!isRenamingProjectSpace) {
            setRenamingProjectSpaceId(null);
          }
        }}
        title={t('workspace.renameTitle')}
        footer={
          <>
            <button
              type="button"
              onClick={() => setRenamingProjectSpaceId(null)}
              disabled={isRenamingProjectSpace}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              form="rename-project-space-form"
              disabled={isRenamingProjectSpace || !renamingProjectSpaceName.trim()}
              className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRenamingProjectSpace ? t('common.saving') : t('workspace.renameAction')}
            </button>
          </>
        }
      >
        <form id="rename-project-space-form" onSubmit={handleRenameProjectSpace} className="space-y-4">
          <div>
            <label htmlFor="rename-project-space-name" className="mb-2 block text-sm font-medium text-text-main">
              {t('workspace.nameLabel')}
            </label>
            <input
              id="rename-project-space-name"
              ref={renameProjectSpaceInputRef}
              type="text"
              value={renamingProjectSpaceName}
              maxLength={80}
              onChange={(event) => {
                setRenamingProjectSpaceName(event.target.value);
                if (renameProjectSpaceError) setRenameProjectSpaceError(null);
              }}
              aria-invalid={!!renameProjectSpaceError}
              className="w-full rounded-lg border border-border bg-bg-base px-3 py-2.5 text-sm text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
              <p className={renameProjectSpaceError ? 'text-red-400' : 'text-text-muted'}>
                {renameProjectSpaceError || t('workspace.nameHint')}
              </p>
              <span className="shrink-0 text-text-muted">{renamingProjectSpaceName.trim().length}/80</span>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!deleteProjectSpaceTarget}
        onClose={() => {
          if (!isDeletingProjectSpace) {
            setDeleteProjectSpaceTarget(null);
          }
        }}
        title={t('workspace.deleteTitle')}
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeleteProjectSpaceTarget(null)}
              disabled={isDeletingProjectSpace}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={confirmDeleteProjectSpace}
              disabled={isDeletingProjectSpace}
              className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isDeletingProjectSpace ? t('common.loading') : t('workspace.deleteAction')}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            {t('workspace.deleteConfirm', { name: deleteProjectSpaceTarget?.name || '' })}
          </p>
          <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs leading-5 text-red-300">
            {t('workspace.deleteWarning')}
          </p>
          {deleteProjectSpaceError && (
            <p className="text-sm text-red-400">{deleteProjectSpaceError}</p>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t('common.delete')}
        footer={
          <>
            <button
              onClick={() => setDeleteId(null)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={confirmDelete}
              className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          {t('common.deleteConversationBody')}
        </p>
      </Modal>

      <Modal
        isOpen={isWorkspaceBrowserOpen}
        onClose={() => setIsWorkspaceBrowserOpen(false)}
        title={t('workspace.workspaceBrowserTitle')}
        maxWidth="2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsWorkspaceBrowserOpen(false)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors"
            >
              {t('common.close')}
            </button>
            <button
              type="button"
              onClick={handleOpenCreateProjectSpace}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
            >
              <Plus className="h-4 w-4" />
              {t('workspace.createAction')}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-text-main">
              {t('workspace.allWorkspacesCount', { count: projectSpaces.length })}
            </p>
          </div>
          <div className="max-h-[58vh] space-y-2 overflow-y-auto pr-1">
            {projectSpaces.map(renderWorkspaceRow)}
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isConversationBrowserOpen}
        onClose={() => setIsConversationBrowserOpen(false)}
        title={t('workspace.conversationBrowserTitle')}
        maxWidth="3xl"
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-main">{currentWorkspaceName}</p>
              <p className="mt-1 text-xs text-text-muted">
                {t('workspace.conversationCount', { count: currentProjectConversations.length })}
              </p>
            </div>
            <div className="flex shrink-0 rounded-lg border border-border bg-bg-base p-0.5">
              <button
                onClick={() => setConversationFilter('active')}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  conversationFilter === 'active' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-main'
                }`}
              >
                {t('chat.showActive')}
              </button>
              <button
                onClick={() => setConversationFilter('archived')}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  conversationFilter === 'archived' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-main'
                }`}
              >
                {t('chat.showArchived')}
              </button>
            </div>
          </div>

          {currentProjectConversations.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-bg-base px-4 py-8 text-center text-sm text-text-muted">
              {conversationFilter === 'archived' ? t('sidebar.noArchivedConversations') : t('sidebar.noConversations')}
            </div>
          ) : (
            <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {currentProjectConversations.map((conv) => renderConversationRow(conv, 'modal'))}
            </div>
          )}
        </div>
      </Modal>

      {/* Mobile Sidebar Overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        fixed md:relative inset-y-0 left-0 z-50
        w-72 max-w-[calc(100vw-1rem)] bg-bg-sidebar border-r border-border flex flex-col transition-transform duration-300
        ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `} data-testid="app-sidebar">
        <div className="border-b border-border p-4">
          <div className="relative mb-4 flex items-center">
            <button
              type="button"
              onClick={() => {
                navigate('/');
                setIsMobileMenuOpen(false);
              }}
              className="flex min-w-0 items-center gap-2 rounded-xl px-1 py-1 text-left transition-colors hover:bg-bg-surface"
              title="ChatLLM"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-sm font-bold text-white">
                C
              </span>
              <span className="truncate text-lg font-semibold text-text-main">ChatLLM</span>
            </button>
            {/* Close button for mobile */}
            <button
              onClick={() => setIsMobileMenuOpen(false)}
              className="absolute right-0 rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main md:hidden"
              aria-label={t('common.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-2">
            <button
              onClick={handleNewChat}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-hover"
            >
              <Plus className="w-4 h-4" />
              {t('sidebar.newChat')}
            </button>

            <button
              onClick={() => setSearchOpen(true)}
              data-search-trigger
              className="flex h-10 w-full items-center gap-2 rounded-xl border border-border bg-bg-base px-3 text-sm text-text-muted transition-colors hover:border-primary/50 hover:bg-bg-surface hover:text-text-main"
            >
              <Search className="w-4 h-4" />
              <span className="flex-1 text-left">{t('search.placeholder')}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          <div className="rounded-xl bg-bg-base/40 p-2">
            <div className="flex items-center justify-between px-2 pb-2 pt-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t('workspace.sectionTitle')}</span>
              <button
                onClick={handleOpenCreateProjectSpace}
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main"
                title={t('workspace.createAction')}
                aria-label={t('workspace.createAction')}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setIsWorkspaceBrowserOpen(true)}
                className="group flex w-full items-center gap-3 rounded-xl border border-border bg-bg-surface px-3 py-3 text-left shadow-sm transition-colors hover:border-primary/40"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-bg-base text-primary">
                  <Folder className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-main">{currentWorkspaceName}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                    {t('workspace.workspaceSummary', {
                      conversations: currentWorkspaceTotalConversations,
                      documents: knowledgeFiles.length,
                    })}
                  </span>
                </span>
                {currentProjectSpace?.is_default && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                    {t('workspace.defaultBadge')}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setIsWorkspaceBrowserOpen(true)}
                className="flex h-8 w-full items-center justify-center rounded-lg text-xs font-medium text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main"
              >
                {t('workspace.viewAllWorkspaces', { count: projectSpaces.length })}
              </button>
            </div>
          </div>

          <div className="space-y-2 rounded-xl bg-bg-base/40 p-2">
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-text-muted">
                {t('workspace.conversationSummaryTitle')}
              </span>
              <div className="flex shrink-0 rounded-lg border border-border bg-bg-sidebar p-0.5">
                <button
                  onClick={() => setConversationFilter('active')}
                  className={`rounded-md px-2 py-1 text-[10px] transition-colors ${
                    conversationFilter === 'active' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-main'
                  }`}
                >
                  {t('chat.showActive')}
                </button>
                <button
                  onClick={() => setConversationFilter('archived')}
                  className={`rounded-md px-2 py-1 text-[10px] transition-colors ${
                    conversationFilter === 'archived' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-main'
                  }`}
                >
                  {t('chat.showArchived')}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsConversationBrowserOpen(true)}
              className="group flex w-full items-center gap-3 rounded-xl border border-border bg-bg-surface px-3 py-3 text-left shadow-sm transition-colors hover:border-primary/40"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-bg-base text-primary">
                <MessageSquare className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-text-main">
                  {conversationFilter === 'archived'
                    ? t('workspace.archivedConversationSummary', { count: currentProjectConversations.length })
                    : t('workspace.activeConversationSummary', { count: currentProjectConversations.length })}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                  {t('workspace.conversationsLabel', { name: currentWorkspaceName })}
                </span>
              </span>
              <span className="rounded-full border border-border bg-bg-base px-2 py-0.5 text-xs text-text-muted transition-colors group-hover:border-primary/40 group-hover:text-text-main">
                {currentProjectConversations.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setIsConversationBrowserOpen(true)}
              className="flex h-8 w-full items-center justify-center rounded-lg text-xs font-medium text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main"
            >
              {t('workspace.viewAllConversations', { count: currentProjectConversations.length })}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-bg-base/40 p-2">
            <button
              onClick={() => {
                navigate('/prompts');
                setIsMobileMenuOpen(false);
              }}
              className={`flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                isPromptsPage ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
              }`}
              title={t('sidebar.promptTemplates')}
            >
              <BookOpenText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">{t('sidebar.promptTemplates')}</span>
            </button>
            <button
              onClick={() => {
                navigate('/usage');
                setIsMobileMenuOpen(false);
              }}
              className={`flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                isUsagePage ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
              }`}
              title={t('usage.title')}
            >
              <BarChart3 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">{t('sidebar.usage')}</span>
            </button>
            <button
              onClick={() => {
                navigate('/persona');
                setIsMobileMenuOpen(false);
              }}
              className={`flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                isPersonaPage ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
              }`}
              title={t('sidebar.persona')}
            >
              <UserRound className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">{t('sidebar.persona')}</span>
            </button>
            <button
              onClick={() => {
                navigate('/rag-eval');
                setIsMobileMenuOpen(false);
              }}
              className={`flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                isRagEvalPage ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
              }`}
              title={t('sidebar.ragEvaluation')}
            >
              <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">{t('sidebar.ragEvaluation')}</span>
            </button>
            <button
              onClick={() => {
                navigate('/retrieval-lab');
                setIsMobileMenuOpen(false);
              }}
              className={`flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                isRetrievalLabPage ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
              }`}
              title={t('sidebar.retrievalLab')}
            >
              <Route className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">{t('sidebar.retrievalLab')}</span>
            </button>
            <button
              onClick={() => {
                navigate('/rag-graph');
                setIsMobileMenuOpen(false);
              }}
              className={`col-span-2 flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                isGraphExplorerPage ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
              }`}
              title={t('sidebar.graphExplorer')}
            >
              <Network className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">{t('sidebar.graphExplorer')}</span>
            </button>
          </div>

          {/* Workspace Documents Section */}
          <div className="rounded-xl bg-bg-base/40 p-2">
            <button
              onClick={() => {
                navigate('/knowledge');
                setIsMobileMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors group ${isKnowledgePage
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-muted hover:text-text-main hover:bg-bg-surface'
                }`}
              title={t('workspace.knowledgeScopeHint')}
            >
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="w-4 h-4 shrink-0" />
                <div className="min-w-0 text-left">
                  <span className="block truncate text-xs font-semibold uppercase tracking-wider">{t('sidebar.knowledgeBase')}</span>
                  <span className={`block truncate text-[10px] ${isKnowledgePage ? 'text-white/75' : 'text-text-muted'}`}>
                    {t('workspace.documentsScopeLabel', { name: currentWorkspaceName })}
                  </span>
                </div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${isKnowledgePage
                ? 'bg-primary-hover border-white/20'
                : 'bg-bg-surface border-border group-hover:border-text-muted'
                }`}>
                {knowledgeFiles.length}
              </span>
            </button>
          </div>

        </div>

        <div className="border-t border-border bg-bg-sidebar p-3">
          <div
            onClick={() => {
              navigate('/profile');
              setIsMobileMenuOpen(false);
            }}
            className={`mb-3 flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-bg-base/50 p-2.5 transition-colors group ${location.pathname === '/profile'
              ? 'bg-bg-surface'
              : 'hover:bg-bg-surface'
              }`}
            title={t('profile.title')}
          >
            <img
              src={userAvatarUrl}
              alt={user?.username}
              loading="lazy"
              className="w-8 h-8 rounded-full bg-bg-surface group-hover:scale-105 transition-transform object-cover"
              onError={(e) => {
                e.currentTarget.src = getAvatarUrl(null, userDisplayName, 64);
              }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate text-text-main">{user?.display_name || user?.username}</p>
              <p className="text-xs text-text-muted truncate">@{user?.username}</p>
            </div>
          </div>
          <div className="space-y-2">
            <button
              onClick={() => logout()}
              className="flex w-full items-center justify-center gap-2 rounded-xl py-2 text-sm text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300"
            >
              <LogOut className="w-4 h-4" />
              {t('sidebar.signOut')}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg-base">
        {/* Mobile Header */}
        <div className="md:hidden flex items-center p-2 border-b border-border bg-bg-sidebar">
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="p-2 -ml-1 text-text-muted hover:text-text-main rounded-lg hover:bg-bg-surface"
            title={t('sidebar.openMenu')}
            aria-label={t('sidebar.openMenu')}
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="ml-2 font-semibold text-text-main text-sm">ChatLLM</span>
        </div>

        <Outlet />
      </div>
    </div >
  );
}
