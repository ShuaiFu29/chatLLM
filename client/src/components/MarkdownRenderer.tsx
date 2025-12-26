import React, { useState, memo, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Check, Copy, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface MarkdownRendererProps {
  content: string;
}

interface CodeProps extends React.HTMLAttributes<HTMLElement> {
  inline?: boolean;
}

const MarkdownRenderer = memo(({ content }: MarkdownRendererProps) => {
  const { t } = useTranslation();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = (code: string, index: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIndex(index);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => setCopiedIndex(null), 2000);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const renderContentWithCursor = (children: React.ReactNode) => {
    if (typeof children === 'string' && children.endsWith(' ▍')) {
      return (
        <>
          {children.slice(0, -2)}
          <span className="inline-block w-2 h-5 align-middle bg-primary animate-blink ml-1"></span>
        </>
      );
    }
    return children;
  };

  return (
    <div className="prose prose-invert max-w-none text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          code({ inline, className, children, ...props }: CodeProps) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            const codeIndex = codeString.length; // Simple stable ID strategy

            return !inline && match ? (
              <div key={codeIndex} className="relative group rounded-xl overflow-hidden my-6 border border-border shadow-lg bg-[#0d1117]">
                {/* Mac-style Window Header */}
                <div className="flex items-center justify-between bg-[#1e222d] px-4 py-2.5 border-b border-border">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
                      <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80"></div>
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500/80"></div>
                    </div>
                    <div className="ml-3 flex items-center gap-1.5 text-xs text-text-muted font-medium">
                      <Terminal className="w-3 h-3" />
                      <span className="font-mono">{match[1]}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleCopy(codeString, codeIndex)}
                    className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-2 py-1 rounded"
                    aria-label={copiedIndex === codeIndex ? t('common.copied') : t('common.copy')}
                  >
                    {copiedIndex === codeIndex ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-green-400" />
                        <span className="text-green-400">{t('common.copied')}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>{t('common.copy')}</span>
                      </>
                    )}
                  </button>
                </div>

                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  showLineNumbers={true}
                  lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', color: '#4b5563', textAlign: 'right' }}
                  customStyle={{
                    margin: 0,
                    borderRadius: 0,
                    background: 'transparent', // Make background transparent to avoid overlap
                    fontSize: '0.9rem',
                    lineHeight: '1.5',
                    padding: '1.5rem 1rem',
                  }}
                  codeTagProps={{
                    style: {
                      background: 'transparent', // Ensure code tag doesn't have background
                      fontFamily: 'inherit'
                    }
                  }}
                >
                  {codeString}
                </SyntaxHighlighter>
              </div>
            ) : (
              <code className="bg-primary/10 text-primary-hover px-1.5 py-0.5 rounded text-[0.9em] font-mono font-medium" {...props}>
                {children}
              </code>
            );
          },
          p({ children }) {
            return <p className="mb-4 last:mb-0 leading-7 text-text-main">{renderContentWithCursor(children)}</p>;
          },
          ul({ children }) {
            return <ul className="list-disc pl-5 mb-4 space-y-2 text-text-main marker:text-text-muted">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal pl-5 mb-4 space-y-2 text-text-main marker:text-text-muted">{children}</ol>;
          },
          li({ children }) {
            return <li className="pl-1">{renderContentWithCursor(children)}</li>;
          },
          h1({ children }) {
            return <h1 className="text-2xl font-bold mb-4 mt-6 text-text-main border-b border-border pb-2">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-xl font-bold mb-3 mt-5 text-text-main">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-lg font-bold mb-2 mt-4 text-text-main">{children}</h3>;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary-hover underline decoration-primary/30 underline-offset-2 transition-colors">
                {children}
              </a>
            );
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-primary/50 pl-4 py-1 my-4 bg-bg-surface rounded-r italic text-text-muted">
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-6 rounded-lg border border-border shadow-sm">
                <table className="min-w-full divide-y divide-border bg-bg-surface">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-bg-sidebar">{children}</thead>;
          },
          th({ children }) {
            return (
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider border-b border-border">
                {children}
              </th>
            );
          },
          tbody({ children }) {
            return <tbody className="divide-y divide-border bg-bg-base/50">{children}</tbody>;
          },
          td({ children }) {
            return <td className="px-4 py-3 text-sm text-text-main whitespace-nowrap">{children}</td>;
          },
          hr() {
            return <hr className="my-6 border-border" />;
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
