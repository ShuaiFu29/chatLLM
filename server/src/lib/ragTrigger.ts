export type RagTriggerReason =
  | 'empty'
  | 'inventory'
  | 'explicit_knowledge'
  | 'document_grounded'
  | 'not_needed';

export interface RagTriggerDecision {
  shouldUseRag: boolean;
  reason: RagTriggerReason;
}

const normalize = (message: string) => message.trim().toLowerCase().replace(/\s+/g, '');

const inventoryTerms = [
  '知识库',
  '文档',
  '文件',
  '资料',
  '上传',
  'knowledgebase',
  'knowledge',
  'uploaded',
  'documents',
  'files',
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

export const getRagTriggerDecision = (message: string): RagTriggerDecision => {
  const normalized = normalize(message);
  if (!normalized) return { shouldUseRag: false, reason: 'empty' };

  const looksLikeInventory = hasAny(normalized, ['多少', '几篇', '几个', '有哪些', '有什么', '清单', '列表', 'list', 'howmany'])
    && hasAny(normalized, inventoryTerms);
  if (looksLikeInventory) return { shouldUseRag: true, reason: 'inventory' };

  if (hasAny(normalized, explicitKnowledgeTerms)) {
    return { shouldUseRag: true, reason: 'explicit_knowledge' };
  }

  const hasGroundingVerb = hasAny(normalized, groundingVerbs);
  const hasDocumentGroundingTerm = hasAny(normalized, documentGroundingTerms);
  if (hasGroundingVerb && hasDocumentGroundingTerm) {
    return { shouldUseRag: true, reason: 'document_grounded' };
  }

  return { shouldUseRag: false, reason: 'not_needed' };
};

export const shouldUseRagForMessage = (message: string) => getRagTriggerDecision(message).shouldUseRag;
