/**
 * Human-authored Chinese retrieval judgements for the deterministic Memory ranker.
 *
 * Every case is judged against the complete memory pool, so a result not listed
 * in `relevantMemoryIds` is a false-positive injection for that query. Keep ids
 * stable: benchmark history and regressions refer to them directly.
 */
export interface AgentMemoryGoldMemory {
  id: string;
  content: string;
  kind: 'fact' | 'preference' | 'decision';
  sourceTrust: 'user_stated' | 'agent_inferred' | 'tool_derived';
  confidence: number;
  createdAt: string;
}

export interface AgentMemoryGoldCase {
  id: string;
  query: string;
  relevantMemoryIds: readonly string[];
}

export interface AgentMemoryGoldDataset {
  formatVersion: 1;
  id: string;
  language: 'zh-CN';
  annotationPolicy: 'exhaustive_against_complete_pool';
  memories: readonly AgentMemoryGoldMemory[];
  cases: readonly AgentMemoryGoldCase[];
}

const memory = (
  id: string,
  content: string,
  kind: AgentMemoryGoldMemory['kind'] = 'fact',
  sourceTrust: AgentMemoryGoldMemory['sourceTrust'] = 'user_stated',
  confidence = 1,
): AgentMemoryGoldMemory => ({
  id,
  content,
  kind,
  sourceTrust,
  confidence,
  createdAt: '2026-08-01T00:00:00.000Z',
});

export const AGENT_MEMORY_ZH_CN_GOLD_V1: AgentMemoryGoldDataset = Object.freeze({
  formatVersion: 1,
  id: 'agent-memory-zh-CN-v1',
  language: 'zh-CN',
  annotationPolicy: 'exhaustive_against_complete_pool',
  memories: Object.freeze([
    memory('mem-01', '用户偏好使用公制单位，温度请用摄氏度。', 'preference'),
    memory('mem-02', '用户界面语言选择简体中文。', 'preference'),
    memory('mem-03', '用户所在时区是 Asia/Shanghai（中国标准时间）。'),
    memory('mem-04', '回答风格应当简洁，先给结论再补充原因。', 'preference'),
    memory('mem-05', '用户已经禁用深色模式，目前使用浅色主题。', 'preference'),
    memory('mem-06', '用户对花生严重过敏，餐饮建议必须避开花生。'),
    memory('mem-07', '工作日会议安排在上午十点以后。', 'preference'),
    memory('mem-08', '费用报销和账单默认使用人民币 CNY。', 'decision'),
    memory('mem-09', 'ChatLLM 后端已经从 Express 迁移到 NestJS。', 'decision'),
    memory('mem-10', '项目主数据库使用 PostgreSQL。', 'decision'),
    memory('mem-11', '异步任务队列采用 BullMQ，Redis 仅负责唤醒。', 'decision'),
    memory('mem-12', '生产数据库每天备份一次，备份保留三十天。', 'decision'),
    memory('mem-13', '所有会产生外部写入的工具都需要人工审批。', 'decision'),
    memory('mem-14', '只读搜索工具可以在策略允许时免审批执行。', 'decision'),
    memory('mem-15', '生产服务部署区域是新加坡 ap-southeast-1。'),
    memory('mem-16', '对象存储使用 MinIO，桶名称是 chatllm-documents。', 'decision'),
    memory('mem-17', '企业登录使用 OIDC，访问令牌有效期十五分钟。', 'decision'),
    memory('mem-18', '知识库检索默认 Top K 是 8。', 'decision'),
    memory('mem-19', '当前中文向量模型是 bge-m3。', 'decision'),
    memory('mem-20', '功能分支统一使用 feat/ 前缀。', 'preference'),
    memory('mem-21', '项目服务端主要开发语言是 TypeScript。'),
    memory('mem-22', '生产日志保留十四天，之后自动清理。', 'decision'),
    memory('mem-23', 'Phoenix 里程碑截止日期是 2026 年 11 月 15 日。'),
    memory('mem-24', '用户已关闭邮件通知，但保留站内通知。', 'preference'),
    memory('mem-25', '当前重点项目代号是 Phoenix。'),
    memory('mem-26', 'API 默认超时时间是二十秒。', 'decision'),
    memory('mem-27', '代码评审至少需要一名维护者批准。', 'decision'),
    memory('mem-28', '发布窗口固定在每周四下午三点。', 'decision'),
    memory('mem-29', '用户偏好使用 VS Code 作为代码编辑器。', 'preference'),
    memory('mem-30', '测试覆盖率目标是百分之八十五。', 'decision'),
  ]),
  cases: Object.freeze([
    { id: 'case-01', query: '温度应该用摄氏度还是华氏度？', relevantMemoryIds: ['mem-01'] },
    { id: 'case-02', query: '界面要显示哪种语言？', relevantMemoryIds: ['mem-02'] },
    { id: 'case-03', query: '用户当前在哪个时区？', relevantMemoryIds: ['mem-03'] },
    { id: 'case-04', query: '回答风格有什么偏好？', relevantMemoryIds: ['mem-04'] },
    { id: 'case-05', query: '现在启用了深色模式吗？', relevantMemoryIds: ['mem-05'] },
    { id: 'case-06', query: '给用户推荐餐食时要避开什么过敏原？', relevantMemoryIds: ['mem-06'] },
    { id: 'case-07', query: '工作日的会议最早几点安排？', relevantMemoryIds: ['mem-07'] },
    { id: 'case-08', query: '费用报销默认使用什么货币？', relevantMemoryIds: ['mem-08'] },
    { id: 'case-09', query: 'ChatLLM 后端现在是 Express 还是 NestJS？', relevantMemoryIds: ['mem-09'] },
    { id: 'case-10', query: '项目主数据库是什么？', relevantMemoryIds: ['mem-10'] },
    { id: 'case-11', query: '异步任务队列使用什么组件？', relevantMemoryIds: ['mem-11'] },
    { id: 'case-12', query: '生产数据库多久备份一次，保留多少天？', relevantMemoryIds: ['mem-12'] },
    { id: 'case-13', query: '外部写入工具是否需要人工审批？', relevantMemoryIds: ['mem-13'] },
    { id: 'case-14', query: '只读搜索工具能不能免审批？', relevantMemoryIds: ['mem-14'] },
    { id: 'case-15', query: '生产服务部署在哪个区域？', relevantMemoryIds: ['mem-15'] },
    { id: 'case-16', query: '对象存储使用什么服务和桶？', relevantMemoryIds: ['mem-16'] },
    { id: 'case-17', query: '企业登录协议和访问令牌有效期是什么？', relevantMemoryIds: ['mem-17'] },
    { id: 'case-18', query: '知识库检索的默认 Top K 是多少？', relevantMemoryIds: ['mem-18'] },
    { id: 'case-19', query: '当前中文向量模型是哪一个？', relevantMemoryIds: ['mem-19'] },
    { id: 'case-20', query: '新功能分支应该使用什么前缀？', relevantMemoryIds: ['mem-20'] },
    { id: 'case-21', query: '服务端主要使用哪种开发语言？', relevantMemoryIds: ['mem-21'] },
    { id: 'case-22', query: '生产日志会保留多久？', relevantMemoryIds: ['mem-22'] },
    { id: 'case-23', query: 'Phoenix 里程碑的截止日期是什么时候？', relevantMemoryIds: ['mem-23'] },
    { id: 'case-24', query: '用户是否接收邮件通知？', relevantMemoryIds: ['mem-24'] },
    { id: 'case-25', query: '当前重点项目的代号是什么？', relevantMemoryIds: ['mem-25'] },
    { id: 'case-26', query: 'API 默认超时是多少秒？', relevantMemoryIds: ['mem-26'] },
    { id: 'case-27', query: '代码评审需要几名维护者批准？', relevantMemoryIds: ['mem-27'] },
    { id: 'case-28', query: '每周的发布窗口在什么时候？', relevantMemoryIds: ['mem-28'] },
    { id: 'case-29', query: '用户偏好哪个代码编辑器？', relevantMemoryIds: ['mem-29'] },
    { id: 'case-30', query: '测试覆盖率目标是多少？', relevantMemoryIds: ['mem-30'] },
    { id: 'case-31', query: '用户最喜欢的音乐人是谁？', relevantMemoryIds: [] },
    { id: 'case-32', query: '下周北京的天气会下雨吗？', relevantMemoryIds: [] },
    { id: 'case-33', query: '用户的护照号码是多少？', relevantMemoryIds: [] },
    { id: 'case-34', query: '办公室停车位编号是什么？', relevantMemoryIds: [] },
  ]),
});
