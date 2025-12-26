import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export default function Modal({ isOpen, onClose, title, children, footer }: ModalProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 transition-all duration-300 animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="bg-bg-sidebar border border-border rounded-2xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all duration-300 animate-in zoom-in-95 slide-in-from-bottom-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <h3 className="text-lg font-semibold text-text-main">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 text-text-muted hover:text-text-main hover:bg-bg-surface rounded-full transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-6 text-text-main text-sm leading-relaxed">
          {children}
        </div>

        {footer && (
          <div className="flex justify-end gap-3 px-6 py-4 bg-bg-surface/50 border-t border-border/50">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
