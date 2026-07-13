export type RagTriggerReason =
  | 'empty'
  | 'inventory'
  | 'explicit_knowledge'
  | 'document_grounded'
  | 'explicit_skip'
  | 'default_rag';

export interface RagTriggerDecision {
  shouldUseRag: boolean;
  reason: RagTriggerReason;
}

const normalize = (message: string) => message.trim().toLowerCase().replace(/\s+/g, '');

const inventoryScopeTerms = [
  '知识库',
  '工作区文档',
  '工作区文件',
  '上传的文档',
  '上传的文件',
  '上传的资料',
  '已上传文档',
  '已上传文件',
  'knowledgebase',
  'workspace documents',
  'uploaded documents',
  'uploaded files',
];

const explicitKnowledgeTerms = [
  '知识库',
  '工作区文档',
  '上传的文档',
  '上传文件',
  '上传的文件',
  '上传资料',
  '原文',
  '引用',
  '来源',
  '证据',
  '检索',
  '文档里',
  '文件里',
  '资料里',
  '材料里',
  '根据文档',
  '基于文档',
  '结合文档',
  '参考文档',
  '根据资料',
  '基于资料',
  '结合资料',
  '参考资料',
  '根据上传',
  '基于上传',
  'markdown',
  '.md',
  'knowledgebase',
  'workspace documents',
  'uploaded documents',
  'uploaded files',
  'source document',
  'source documents',
  'citations',
  'references',
  'retrieved',
  'document says',
  'documents say',
  'according to the document',
  'according to the uploaded',
];

const documentGroundingTerms = [
  '制度',
  '政策',
  '规程',
  '规范',
  '指南',
  '手册',
  '报告',
  '备忘录',
  '清单',
  '条款',
  '规则',
  '原始记录',
  '审计记录',
  '补正意见',
  '注册资料',
  '质保',
  '审批',
  '合规',
  'regulation',
  'policy',
  'procedure',
  'manual',
  'report',
  'memo',
  'audit',
  'evidence',
  'compliance',
];

const groundingVerbs = [
  '根据',
  '基于',
  '结合',
  '参考',
  '查看',
  '查一下',
  '查找',
  '总结',
  '概述',
  '定位',
  '出处',
  '证明',
  'compare',
  'summarize',
  'find',
  'locate',
  'based on',
  'according to',
];

const hasAny = (value: string, terms: string[]) => terms.some((term) => value.includes(term.toLowerCase().replace(/\s+/g, '')));

const greetingOnlyTerms = new Set([
  '你好',
  '您好',
  '嗨',
  '哈喽',
  '早上好',
  '下午好',
  '晚上好',
  '谢谢',
  '多谢',
  '再见',
  'hello',
  'hi',
  'thanks',
  'thankyou',
  'bye',
]);

const stripConversationalPunctuation = (value: string) => value.replace(/[，。！？、,.!?~～]/g, '');

const looksLikeInventoryRequest = (normalized: string) => {
  if (!hasAny(normalized, inventoryScopeTerms)) return false;

  return [
    /(?:知识库|工作区)(?:里面|里|中|内)?(?:一共有|总共有|一共|总共|共有|有)?(?:多少|几)(?:篇|个)?(?:文档|文件|资料)?/,
    /(?:列出|罗列|展示)(?:知识库|工作区|上传的|已上传的)?(?:全部|所有)?(?:文档|文件|资料)/,
    /(?:上传了|已上传|上传的)(?:哪些|什么|多少|几|全部|所有)(?:文档|文件|资料|内容)?/,
    /(?:知识库|工作区)(?:里|中|内|里面)?(?:有哪些|有什么)(?:文档|文件|资料)/,
    /(?:howmany|list|which|what)(?:uploaded|workspace)?(?:documents|files)/,
  ].some((pattern) => pattern.test(normalized));
};

const isExplicitTranslationTask = (message: string, normalized: string) => {
  const asksForTranslation = hasAny(normalized, ['翻译成', '翻译为', '翻译一下', 'translateinto', 'translateto']);
  const suppliesText = /[:：“”"'‘’]/.test(message)
    || hasAny(normalized, ['这句话', '以下内容', '下面内容', '下列内容', 'followingtext']);
  return asksForTranslation && suppliesText;
};

const isExplicitWritingTask = (message: string, normalized: string) => {
  const asksForWriting = hasAny(normalized, [
    '帮我写',
    '写一封',
    '写一篇',
    '撰写',
    '改写',
    '润色',
    '续写',
    'rewrite',
    'proofread',
  ]);
  if (!asksForWriting) return false;

  const referencesWorkspaceKnowledge = hasAny(normalized, explicitKnowledgeTerms)
    || hasAny(normalized, documentGroundingTerms)
    || /[A-Za-z]+(?:-[A-Za-z0-9]+)+/.test(message);
  return !referencesWorkspaceKnowledge;
};

const isSimpleArithmetic = (normalized: string) => {
  const expression = normalized
    .replace(/[？?]/g, '')
    .replace(/^(?:请问|请计算|计算|帮我算|算一下)/, '')
    .replace(/(?:等于多少|是多少|结果是什么|等于几|等于)$/, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(expression)) return false;
  return /[+\-*/×÷]/.test(expression) && /^[\d.+\-*/×÷()%（）]+$/.test(expression);
};

const isExplicitSkip = (message: string, normalized: string) => {
  const greetingCandidate = stripConversationalPunctuation(normalized);
  return greetingOnlyTerms.has(greetingCandidate)
    || isExplicitTranslationTask(message, normalized)
    || isExplicitWritingTask(message, normalized)
    || isSimpleArithmetic(normalized);
};

export const getRagTriggerDecision = (message: string): RagTriggerDecision => {
  const normalized = normalize(message);
  if (!normalized) return { shouldUseRag: false, reason: 'empty' };

  if (looksLikeInventoryRequest(normalized)) return { shouldUseRag: true, reason: 'inventory' };

  if (hasAny(normalized, explicitKnowledgeTerms)) {
    return { shouldUseRag: true, reason: 'explicit_knowledge' };
  }

  const hasGroundingVerb = hasAny(normalized, groundingVerbs);
  const hasDocumentGroundingTerm = hasAny(normalized, documentGroundingTerms);
  if (hasGroundingVerb && hasDocumentGroundingTerm) {
    return { shouldUseRag: true, reason: 'document_grounded' };
  }

  if (isExplicitSkip(message, normalized)) {
    return { shouldUseRag: false, reason: 'explicit_skip' };
  }

  return { shouldUseRag: true, reason: 'default_rag' };
};

export const shouldUseRagForMessage = (message: string) => getRagTriggerDecision(message).shouldUseRag;
