import { useEffect } from 'react';
import { Command } from 'cmdk';
import { Search, Loader2, MessageSquare, Calendar } from 'lucide-react';
import { useSearchStore } from '../stores/useSearchStore';
import { useChatStore } from '../stores/useChatStore';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// We'll create a custom CommandPalette component using cmdk
// Since we want to use our existing Modal infrastructure, we can wrap it
// Or we can use a specialized Dialog from Radix UI if we installed it.
// Given the dependencies I installed (cmdk), let's build a nice command palette.

export default function SearchDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isOpen, setIsOpen, query, setQuery, results, isLoading, searchMessages, clearResults } = useSearchStore();
  const { selectConversation } = useChatStore();

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query) {
        searchMessages(query);
      } else {
        clearResults(); // Clear results if query is empty
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, searchMessages, clearResults]);

  // Handle keyboard shortcut (Cmd+K)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsOpen(!isOpen);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [setIsOpen, isOpen]);

  const handleSelect = (result: any) => {
    // 1. Close the dialog
    setIsOpen(false);

    // 2. Navigate and Select
    // We should probably select the conversation first, then navigate
    selectConversation(result.conversation_id);
    navigate('/');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] px-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={() => setIsOpen(false)}
      />

      {/* Palette Container */}
      <div className="relative w-full max-w-2xl bg-bg-sidebar border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <Command className="w-full" shouldFilter={false}>
          <div className="flex items-center px-4 border-b border-border" onClick={() => document.getElementById('search-input')?.focus()}>
            <Search className="w-5 h-5 text-text-muted mr-3" />
            <Command.Input
              id="search-input"
              value={query}
              onValueChange={setQuery}
              placeholder={t('search.placeholder') || "Search messages..."}
              className="w-full h-14 bg-transparent outline-none text-text-main placeholder-text-muted"
              autoFocus
            />
            {isLoading && <Loader2 className="w-4 h-4 text-primary animate-spin ml-2" />}
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-text-muted text-sm">
              {query ? (isLoading ? t('common.loading') : t('search.noResults')) : t('search.typeToSearch')}
            </Command.Empty>

            {results.length > 0 && (
              <Command.Group heading={t('search.results')}>
                {results.map((result) => (
                  <Command.Item
                    key={result.id}
                    onSelect={() => handleSelect(result)}
                    className="flex items-start gap-3 p-3 rounded-lg cursor-pointer hover:bg-bg-surface aria-selected:bg-bg-surface transition-colors group"
                  >
                    <div className="mt-1 p-1.5 bg-primary/10 rounded text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                      <MessageSquare className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-text-main truncate">
                          {result.conversations?.title || 'Unknown Chat'}
                        </span>
                        <span className="flex items-center text-xs text-text-muted">
                          <Calendar className="w-3 h-3 mr-1" />
                          {new Date(result.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm text-text-muted line-clamp-2 break-all">
                        {/* Highlight match logic could go here */}
                        {result.content}
                      </p>
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>

        <div className="px-4 py-2 bg-bg-surface/50 border-t border-border flex items-center justify-between text-xs text-text-muted">
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-bg-base border border-border rounded flex items-center justify-center min-w-[20px]">Cmd K</span>
            <span>to open</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-bg-base border border-border rounded flex items-center justify-center min-w-[20px]">Esc</span>
            <span>to close</span>
          </div>
        </div>
      </div>
    </div>
  );
}