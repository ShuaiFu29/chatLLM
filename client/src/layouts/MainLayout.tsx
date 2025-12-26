import { useEffect, useState, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatStore } from '../stores/useChatStore';
import { MessageSquare, Plus, LogOut, Database, Trash2, Pencil, Menu, X, Search } from 'lucide-react';
import api from '../lib/api';
import Modal from '../components/Modal';
import SearchDialog from '../components/SearchDialog';
import { useSearchStore } from '../stores/useSearchStore';

export default function MainLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { setIsOpen: setSearchOpen } = useSearchStore();
  const {
    conversations,
    currentConversationId,
    fetchConversations,
    createConversation,
    deleteConversation,
    renameConversation,
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

  const fetchKnowledgeFiles = async () => {
    try {
      const res = await api.get('/upload/files');
      setKnowledgeFiles(res.data);
    } catch (err) {
      console.error('Failed to fetch knowledge files:', err);
    }
  };

  useEffect(() => {
    const initData = async () => {
      await fetchConversations();
      await fetchKnowledgeFiles();
    };
    initData();

    // Listen for updates from KnowledgeBase component
    const handleKnowledgeUpdate = () => {
      fetchKnowledgeFiles();
    };
    window.addEventListener('knowledge-updated', handleKnowledgeUpdate);

    return () => {
      window.removeEventListener('knowledge-updated', handleKnowledgeUpdate);
    };
  }, [fetchConversations]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
    }
  }, [editingId]);

  const handleSelectConversation = (id: string) => {
    if (editingId) return; // Prevent selection while editing
    selectConversation(id);
    navigate('/');
    setIsMobileMenuOpen(false); // Close sidebar on mobile
  };

  const handleNewChat = async () => {
    await createConversation();
    navigate('/');
    setIsMobileMenuOpen(false); // Close sidebar on mobile
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

  return (
    <div className="flex h-screen overflow-hidden bg-bg-base text-text-main transition-colors duration-300">
      <SearchDialog /><Modal
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
        w-64 bg-bg-sidebar border-r border-border flex flex-col transition-transform duration-300
        ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-center justify-center relative">
            <h1 className="text-xl font-bold text-primary text-center w-full">ChatLLM</h1>
            {/* Close button for mobile */}
            <button
              onClick={() => setIsMobileMenuOpen(false)}
              className="md:hidden p-2 text-text-muted hover:text-text-main absolute right-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <button
            onClick={handleNewChat}
            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white py-2 px-4 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('sidebar.newChat')}
          </button>

          <button
            onClick={() => setSearchOpen(true)}
            data-search-trigger
            className="w-full flex items-center gap-2 bg-bg-surface hover:bg-bg-base text-text-muted hover:text-text-main py-2 px-3 rounded-lg border border-border transition-colors text-sm"
          >
            <Search className="w-4 h-4" />
            <span className="flex-1 text-left">{t('search.placeholder') || 'Search...'}</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors group relative ${currentConversationId === conv.id && !isKnowledgePage && location.pathname === '/'
                ? 'bg-primary text-white'
                : 'text-text-muted hover:bg-bg-surface hover:text-text-main'
                }`}
            >
              <MessageSquare className="w-4 h-4 shrink-0" />

              {editingId === conv.id ? (
                <form onSubmit={handleRenameSubmit} className="flex-1 flex items-center gap-1 min-w-0">
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="flex-1 bg-bg-base text-text-main text-sm px-1 py-0.5 rounded border border-primary outline-none min-w-0"
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
                <span
                  className="truncate text-sm flex-1 cursor-pointer"
                  onClick={() => handleSelectConversation(conv.id)}
                >
                  {conv.title === 'New Chat' ? t('sidebar.newChat') : conv.title}
                </span>
              )}

              {/* Action Buttons */}
              {!editingId && (
                <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${currentConversationId === conv.id ? 'text-white' : 'text-text-muted'
                  }`}>
                  <button
                    onClick={(e) => handleEditClick(e, conv.id, conv.title)}
                    className={`p-1 hover:bg-white/20 rounded transition-colors`}
                    title="Rename"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => handleDeleteClick(e, conv.id)}
                    className={`p-1 hover:bg-red-500/80 hover:text-white rounded transition-colors`}
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="text-text-muted text-sm text-center mt-4">{t('sidebar.noConversations')}</div>
          )}

          {/* Knowledge Base Section */}
          <div className="pt-4 mt-4 border-t border-border">
            <button
              onClick={() => {
                navigate('/knowledge');
                setIsMobileMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors group ${isKnowledgePage
                ? 'bg-primary text-white'
                : 'text-text-muted hover:text-text-main hover:bg-bg-surface'
                }`}
            >
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider">{t('sidebar.knowledgeBase')}</span>
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

        <div className="p-4 border-t border-border bg-bg-sidebar">
          <div
            onClick={() => {
              navigate('/profile');
              setIsMobileMenuOpen(false);
            }}
            className={`flex items-center gap-3 mb-3 p-2 -mx-2 rounded-lg cursor-pointer transition-colors group ${location.pathname === '/profile'
              ? 'bg-bg-surface'
              : 'hover:bg-bg-surface'
              }`}
            title="View Profile & Settings"
          >
            <img
              src={user?.avatar_url}
              alt={user?.username}
              loading="lazy"
              className="w-8 h-8 rounded-full bg-bg-surface group-hover:scale-105 transition-transform object-cover"
              onError={(e) => (e.currentTarget.src = `https://ui-avatars.com/api/?name=${user?.display_name || user?.username || 'User'}`)}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate text-text-main">{user?.display_name || user?.username}</p>
              <p className="text-xs text-text-muted truncate">@{user?.username}</p>
            </div>
          </div>
          <div className="space-y-2">
            <button
              onClick={() => logout()}
              className="w-full flex items-center justify-center gap-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/20 py-2 rounded transition-colors"
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
