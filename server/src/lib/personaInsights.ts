export interface PersonaMessageInput {
  id: string;
  content: string;
  created_at?: string | null;
}

export interface PersonaProfileDraft {
  summary: string;
  role_label: string;
  goals: string[];
  preferences: string[];
  avoided_topics: string[];
  memory_enabled: boolean;
  updated_by_user_at?: string | null;
}

export interface PersonaObservationDraft {
  category: string;
  label: string;
  detail: string;
  confidence: number;
  evidence_count: number;
  evidence_message_ids: string[];
}

export interface PersonaInterestDraft {
  topic: string;
  score: number;
  trend: 'rising' | 'steady' | 'cooling';
  evidence_count: number;
  evidence_message_ids: string[];
  last_seen_at?: string | null;
}

export interface PersonaSuggestionDraft {
  topic: string;
  question: string;
  reason: string;
  confidence: number;
}

export interface PersonaAnalysisResult {
  profile: PersonaProfileDraft;
  observations: PersonaObservationDraft[];
  interests: PersonaInterestDraft[];
  suggestions: PersonaSuggestionDraft[];
}

interface TopicDefinition {
  topic: string;
  keywords: string[];
  observationCategory: string;
  observationLabel: string;
  observationDetail: string;
  suggestionQuestion: string;
  suggestionReason: string;
}

const TOPICS: TopicDefinition[] = [
  {
    topic: 'Agentic RAG 与知识检索',
    keywords: ['agentic rag', 'rag', '检索', '知识库', '向量', 'milvus', 'embedding', 'bm25', 'elasticsearch', 'es ', 'rerank', '引用', '召回', '知识图谱', 'trace'],
    observationCategory: 'project_focus',
    observationLabel: '关注 Agentic RAG 链路',
    observationDetail: '持续关注 Agentic RAG、知识检索、引用可靠性和测评链路。',
    suggestionQuestion: '如何把 Agentic RAG 的检索、评测和 trace 链路包装成项目亮点？',
    suggestionReason: '你最近多次围绕 RAG 检索、引用、知识图谱和测评机制做取舍。',
  },
  {
    topic: '企业级稳定性与大文件上传',
    keywords: ['企业级', '高并发', '稳定性', '超大文件', '分片上传', 'minio', '队列', '兜底', '限流', '压测', '异步', 'worker', 'postgres', 'redis'],
    observationCategory: 'engineering_standard',
    observationLabel: '重视企业级工程质量',
    observationDetail: '重视企业级稳定性、并发、上传链路和异常兜底策略。',
    suggestionQuestion: 'ChatLLM 的上传、队列和检索链路还可以怎样做企业级压测？',
    suggestionReason: '你持续要求项目能承受高并发、海量文档和异常恢复场景。',
  },
  {
    topic: '前端体验与产品打磨',
    keywords: ['界面', '布局', '难看', '弹窗', 'ui', 'i18n', 'playwright', '渲染', 'placeholder', '交互', '按钮'],
    observationCategory: 'product_taste',
    observationLabel: '重视界面可读性',
    observationDetail: '对界面布局、可读性、i18n 和交互一致性要求较高。',
    suggestionQuestion: '哪些页面最适合继续做 UI 收敛和可用性测试？',
    suggestionReason: '你最近频繁指出布局、弹窗、文案和可读性问题。',
  },
  {
    topic: '简历与面试表达',
    keywords: ['简历', '面试', '亮点', '项目定位', '项目简介', '难点', '怎么写', '实习'],
    observationCategory: 'career_goal',
    observationLabel: '关注项目表达',
    observationDetail: '关注如何把项目能力沉淀为简历、面试和作品集中的清晰表达。',
    suggestionQuestion: '这个项目目前最适合写进简历的 3 个技术亮点是什么？',
    suggestionReason: '你之前多次询问项目定位、难点、亮点和简历写法。',
  },
  {
    topic: '后端架构与服务治理',
    keywords: ['express', 'nest', '后端', '架构', '消息队列', '限流', '监控', 'metrics', '健康检查', '服务治理', '数据库', '索引'],
    observationCategory: 'architecture_focus',
    observationLabel: '关注后端架构演进',
    observationDetail: '关注后端服务边界、可观测性、数据库索引和服务治理能力。',
    suggestionQuestion: 'Express 后端下一步如何演进到更适合企业级维护的结构？',
    suggestionReason: '你关心后端是否能抗住企业级负载，以及是否需要架构升级。',
  },
];

const SENSITIVE_PATTERNS = [
  /政治/,
  /宗教/,
  /健康/,
  /疾病/,
  /病史/,
  /身份证/,
  /收入/,
  /家庭住址/,
  /婚育/,
];

const MIN_TOPIC_EVIDENCE_MESSAGES = 2;
const MIN_TOPIC_WEIGHTED_MATCHES = 3;

const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);

const unique = (values: string[], limit: number) => Array.from(new Set(values.filter(Boolean))).slice(0, limit);

const containsSensitiveSignal = (text: string) => SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));

const countMatches = (content: string, keywords: string[]) => {
  const lower = content.toLowerCase();
  return keywords.reduce((count, keyword) => count + (lower.includes(keyword.toLowerCase()) ? 1 : 0), 0);
};

const latestTimestamp = (messages: PersonaMessageInput[]) => {
  const timestamps = messages
    .map((message) => message.created_at ? Date.parse(message.created_at) : 0)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
};

export const analyzePersonaSignals = (messages: PersonaMessageInput[]): PersonaAnalysisResult => {
  const safeMessages = messages
    .filter((message) => message.content && !containsSensitiveSignal(message.content))
    .slice(0, 120);

  const topicScores = TOPICS.map((definition) => {
    const evidenceMessages = safeMessages.filter((message) => countMatches(message.content, definition.keywords) > 0);
    const weightedMatches = evidenceMessages.reduce(
      (sum, message) => sum + countMatches(message.content, definition.keywords),
      0
    );
    const score = clamp((weightedMatches * 0.16) + (evidenceMessages.length * 0.12), 0, 1);

    return {
      definition,
      evidenceMessages,
      weightedMatches,
      score,
    };
  })
    .filter((item) => (
      item.evidenceMessages.length >= MIN_TOPIC_EVIDENCE_MESSAGES
      && item.weightedMatches >= MIN_TOPIC_WEIGHTED_MATCHES
    ))
    .sort((a, b) => b.score - a.score);

  const interests: PersonaInterestDraft[] = topicScores.slice(0, 6).map((item, index) => ({
    topic: item.definition.topic,
    score: Number(item.score.toFixed(2)),
    trend: index <= 1 ? 'rising' : 'steady',
    evidence_count: item.evidenceMessages.length,
    evidence_message_ids: unique(item.evidenceMessages.map((message) => message.id), 12),
    last_seen_at: latestTimestamp(item.evidenceMessages),
  }));

  const observations: PersonaObservationDraft[] = topicScores.slice(0, 5).map((item) => ({
    category: item.definition.observationCategory,
    label: item.definition.observationLabel,
    detail: item.definition.observationDetail,
    confidence: Number(clamp(item.score + 0.2).toFixed(2)),
    evidence_count: item.evidenceMessages.length,
    evidence_message_ids: unique(item.evidenceMessages.map((message) => message.id), 12),
  }));

  const suggestions: PersonaSuggestionDraft[] = topicScores.slice(0, 5).map((item) => ({
    topic: item.definition.topic,
    question: item.definition.suggestionQuestion,
    reason: item.definition.suggestionReason,
    confidence: Number(clamp(item.score + 0.1).toFixed(2)),
  }));

  const topTopics = interests.map((interest) => interest.topic);
  const hasEvidenceBackedProfile = topicScores.length > 0;
  const summary = hasEvidenceBackedProfile
    ? `你最近主要围绕 ${topTopics.slice(0, 3).join('、')} 推进 ChatLLM 的产品化和工程质量。`
    : '';

  const profile: PersonaProfileDraft = {
    summary,
    role_label: !hasEvidenceBackedProfile
      ? ''
      : topicScores.some((item) => item.definition.topic.includes('后端'))
      ? 'AI 应用/全栈项目开发者'
      : 'AI 应用项目开发者',
    goals: hasEvidenceBackedProfile ? unique([
      topicScores.some((item) => item.definition.topic.includes('Agentic RAG')) ? '完善 Agentic RAG、引用、评测和 trace 链路' : '',
      topicScores.some((item) => item.definition.topic.includes('企业级')) ? '提升项目在企业级高并发和海量数据场景下的稳定性' : '',
      topicScores.some((item) => item.definition.topic.includes('简历')) ? '沉淀适合简历和面试表达的项目亮点' : '',
      '把 ChatLLM 打磨成可展示、可运行、可验证的高质量项目',
    ], 6) : [],
    preferences: hasEvidenceBackedProfile ? unique([
      '希望功能直接落地，并用可验证的测试或真实流程确认效果',
      '偏好中文解释、清晰方案和少走弯路的工程判断',
      topicScores.some((item) => item.definition.topic.includes('前端')) ? '重视界面可读性、弹窗承载复杂信息和 i18n 完整性' : '',
      topicScores.some((item) => item.definition.topic.includes('企业级')) ? '倾向采用有兜底策略的企业级架构设计' : '',
    ], 6) : [],
    avoided_topics: ['不要自动推断敏感身份信息', '不要把与当前项目无关的能力强行塞进产品'],
    memory_enabled: true,
  };

  return { profile, observations, interests, suggestions };
};

export const mergePersonaProfile = (
  existing: Partial<PersonaProfileDraft> | null | undefined,
  generated: PersonaProfileDraft
): PersonaProfileDraft => {
  if (existing?.updated_by_user_at) {
    return {
      summary: existing.summary ?? generated.summary,
      role_label: existing.role_label ?? generated.role_label,
      goals: existing.goals ?? generated.goals,
      preferences: existing.preferences ?? generated.preferences,
      avoided_topics: existing.avoided_topics ?? generated.avoided_topics,
      memory_enabled: existing.memory_enabled !== false,
      updated_by_user_at: existing.updated_by_user_at,
    };
  }

  return {
    ...generated,
    memory_enabled: existing?.memory_enabled !== false,
  };
};

export const buildPersonalizedSystemPrompt = (
  baseSystemPrompt: string,
  profile: Partial<PersonaProfileDraft> | null | undefined
) => {
  if (!profile?.memory_enabled) return baseSystemPrompt;

  const hasManualEdits = Boolean(profile.updated_by_user_at);
  const hasProfileContent = Boolean(
    profile.summary
    || profile.role_label
    || profile.goals?.length
    || profile.preferences?.length
    || (hasManualEdits && profile.avoided_topics?.length)
  );
  if (!hasProfileContent) return baseSystemPrompt;

  const compactProfile = [
    profile.summary ? `Summary: ${profile.summary}` : '',
    profile.role_label ? `Role: ${profile.role_label}` : '',
    profile.goals?.length ? `Goals: ${profile.goals.slice(0, 3).join('; ')}` : '',
    profile.preferences?.length ? `Preferences: ${profile.preferences.slice(0, 3).join('; ')}` : '',
    profile.avoided_topics?.length ? `Avoid: ${profile.avoided_topics.slice(0, 3).join('; ')}` : '',
  ].filter(Boolean).join('\n');

  return `${baseSystemPrompt}

User profile:
${compactProfile}

Use this profile only to personalize wording, priorities, and suggested next steps. Do not use it as factual evidence, do not infer sensitive traits, and never let it override retrieved documents or explicit user instructions.`;
};
