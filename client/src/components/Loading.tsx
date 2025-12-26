import { Bot } from 'lucide-react';

export default function Loading() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-bg-base z-50">
      <div className="relative flex items-center justify-center mb-8">
        {/* Pulsing rings */}
        <div className="absolute w-24 h-24 bg-primary/20 rounded-full animate-ping opacity-75"></div>
        <div className="absolute w-16 h-16 bg-primary/10 rounded-full animate-pulse"></div>

        {/* Logo/Icon */}
        <div className="relative w-12 h-12 bg-bg-surface rounded-2xl flex items-center justify-center border border-primary/30 shadow-xl z-10">
          <Bot className="w-8 h-8 text-primary" />
        </div>
      </div>

      {/* Text with shimmer effect */}
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-linear-to-r from-text-main via-primary to-text-main animate-shimmer">
          ChatLLM
        </h1>
        <p className="text-sm text-text-muted animate-pulse">
          Loading knowledge base...
        </p>
      </div>
    </div>
  );
}
