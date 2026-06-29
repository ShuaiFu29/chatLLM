import type { Conversation, Message } from '../stores/useChatStore';

const MODEL_LABELS: Record<string, string> = {
  'deepseek-chat': 'DeepSeek-V3',
  'deepseek-reasoner': 'DeepSeek-R1',
};

interface BuildConversationMarkdownInput {
  conversation?: Conversation | null;
  messages: Message[];
  workspaceName?: string;
  exportedAt?: string | Date;
}

const formatDate = (value?: string | Date) => {
  if (!value) return 'Unknown';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toISOString();
};

const formatRole = (role: Message['role']) => role === 'assistant' ? 'Assistant' : 'User';

const formatModel = (model?: string) => {
  if (!model) return 'DeepSeek-V3';
  return MODEL_LABELS[model] || model;
};

const normalizeSourceSnippet = (content: string) => {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
};

export const buildConversationMarkdown = ({
  conversation,
  messages,
  workspaceName,
  exportedAt = new Date(),
}: BuildConversationMarkdownInput) => {
  const title = conversation?.title?.trim() || 'Untitled conversation';
  const exportableMessages = messages.filter((message) => message.content.trim() || message.sources?.length);
  const lines: string[] = [
    `# ${title}`,
    '',
    `- Workspace: ${workspaceName || 'Workspace'}`,
    `- Model: ${formatModel(conversation?.model)}`,
    `- Created: ${formatDate(conversation?.created_at)}`,
    `- Updated: ${formatDate(conversation?.updated_at)}`,
    `- Exported: ${formatDate(exportedAt)}`,
    `- Messages: ${exportableMessages.length}`,
    '',
    '---',
    '',
  ];

  for (const message of exportableMessages) {
    lines.push(`## ${formatRole(message.role)} · ${formatDate(message.created_at)}`);
    lines.push('');
    lines.push(message.content.trim() || '_No text content._');
    lines.push('');

    if (message.sources?.length) {
      lines.push('### Sources');
      lines.push('');
      message.sources.forEach((source, index) => {
        const chunkLabel = typeof source.chunk_index === 'number' ? ` · chunk ${source.chunk_index}` : '';
        const similarityLabel = Number.isFinite(source.similarity) ? ` · similarity ${source.similarity.toFixed(3)}` : '';
        lines.push(`${index + 1}. \`${source.filename}\`${chunkLabel}${similarityLabel}`);
        if (source.content?.trim()) {
          lines.push(`   > ${normalizeSourceSnippet(source.content)}`);
        }
      });
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
};

export const createConversationExportFilename = (title: string, exportedAt: string | Date = new Date()) => {
  const date = formatDate(exportedAt).slice(0, 10);
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'conversation';

  return `chatllm-${date}-${slug}.md`;
};

export const downloadTextFile = (filename: string, content: string, mimeType = 'text/markdown;charset=utf-8') => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
