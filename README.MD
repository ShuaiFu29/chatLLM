# ChatLLM - AI 聊天与 Agentic RAG 知识工作台

ChatLLM 是一个前后端分离的 AI 聊天与 Agentic RAG 知识工作台。用户可以通过 GitHub OAuth 登录，把会话、Markdown 文档、项目空间、检索引用、RAG 质量评测和使用追踪组织在同一个工作台里。

当前架构已经移除 Supabase，改为本地 Docker Compose 栈：

- React + Vite 前端
- NestJS + Fastify + TypeScript 后端
- PostgreSQL 业务数据库
- Redis 7 + BullMQ 唤醒队列与原子限流
- MinIO 文件存储
- Python FastAPI RAG 服务
- Milvus 向量数据库
- Elasticsearch BM25 检索
- Neo4j 知识图谱

## 系统架构

```mermaid
flowchart LR
  Client["React/Vite Client"] -->|HTTP + Cookies| Server["NestJS/Fastify API Server"]
  Server -->|SQL| Postgres["PostgreSQL"]
  Server -->|BullMQ jobs / rate limits| Redis["Redis 7"]
  Server -->|S3 API| MinIO["MinIO Documents Bucket"]
  Server -->|/ingest /retrieve /cleanup-file| Rag["Python RAG Service"]
  Rag -->|SQL metadata/chunks| Postgres
  Rag -->|Disposable exact-cache L1| CacheRedis["Dedicated Cache Redis"]
  Rag -->|Download source files| MinIO
  Rag -->|Vector insert/search| Milvus["Milvus"]
  Rag -->|BM25 search| ES["Elasticsearch"]
  Rag -->|Entity graph| Neo4j["Neo4j"]
  Server -->|Streaming chat completion| LLM["DeepSeek / Kimi / Qwen compatible APIs"]
```

## 目录结构

```text
chatLLM/
  client/        React 前端
  server/        NestJS + Fastify 后端
  rag-service/   Python RAG 服务
  docker-compose.yml
```

## 技术栈

### Client

- React 19
- Vite
- TypeScript
- Zustand
- TailwindCSS
- react-markdown

### Server

- NestJS 11 + Fastify 5
- TypeScript
- PostgreSQL via `pg`
- Redis 7（BullMQ 投递与原子限流；共享实例使用 `noeviction`）
- BullMQ（Markdown 摄取、RAG 测评、资源清理三类唤醒队列）
- MinIO/S3 via AWS SDK v3
- JWT + HttpOnly cookies
- GitHub OAuth
- SSE 流式输出

### RAG Service

- FastAPI
- Qwen/Bailian compatible Embeddings API
- PostgreSQL chunk metadata
- MinIO source document download
- Milvus vector storage and retrieval
- Elasticsearch BM25 hybrid retrieval
- Neo4j entity graph retrieval
- 对话追问改写、受控并行 Multi-query、RRF、可选语义 Reranker 与 Parent-child Retrieval
- Token Budget 上下文打包、带来源的实际回答、声明级引用/Faithfulness 校验与独立 LLM Judge 维度
- 严格证据约束的 LLM Graph 抽取、保守实体消歧和有界多跳 GraphRAG
- Agentic Trace、证据验证与 RAG 评测中心

队列中的消息只保存数据库记录 ID；任务状态、租约、重试和最终结果仍以 PostgreSQL 为准。Redis 中的消息丢失后，Dispatcher 会从 PostgreSQL 重建投递。PostgreSQL-backed RAG exact cache 保持事实源，`docker compose up -d` 默认同时启动独立的可丢弃 Cache Redis L1；它不能与 BullMQ 的 `noeviction` Redis 共用。Cache Redis 断开时 capability 标记 `degraded` 并自动回退 PostgreSQL，不影响回答正确性。

RAG 缓存保存的是检索证据，不缓存最终生成答案。只有证据验证通过、完全相同的独立检索问题才允许跳过后端检索；Key 同时绑定用户、项目空间、知识和索引版本、检索路由、TopK、阈值、Embedding/Chunk 配置以及 Reranker 版本。会话证据仍按 `conversation_id` 隔离，只作为新检索的候选证据；词项相似 Query 不再直接复用。相同 Key 并发 miss 使用短时单飞合并，等待超时或 Cache Redis 故障时自动回源，不影响回答。

Elasticsearch 使用 `chatllm_chunks_v2` 索引和 `markdown-fields-v2` schema，同时检索文件名、Markdown 标题路径与正文；各文本字段同时保留 standard 与 CJK 分词，文件名和标题获得更高的首轮召回权重。向量输入同样包含文件名、标题路径和正文，避免真实资料只在目录结构或文件名中出现关键概念时无法召回。

## 本地启动

依赖和 `.env` 配置准备好后，优先在项目根目录使用一条命令启动：

```bash
cd D:\project\chatLLM
npm run dev
```

这个命令会自动检查配置和本地端口占用，启动 Docker 基础设施，并同时启动 NestJS/Fastify 后端、Python RAG 服务和 React 前端。

如果 `npm run dev` 提示 `Port check failed`，说明后端、前端或 RAG 端口已经被其他项目或旧进程占用。先关闭占用 `3000` / `5173` / `8000` 的进程，再重新启动。也可以单独执行：

```bash
cd D:\project\chatLLM
npm run check:ports
```

RAG 链路可以用本地 deterministic embedding 做端到端冒烟验证，不消耗外部 embedding API 额度：

```bash
cd D:\project\chatLLM
npm run rag:smoke
```

这个命令会临时启动一个独立 RAG 服务，写入临时 PostgreSQL / MinIO 数据，验证 ingest、Milvus 写入、retrieve 命中，然后清理临时数据。

如果使用 pnpm，也可以执行：

```bash
cd D:\project\chatLLM
pnpm run dev
```

### Python RAG 依赖

RAG 服务的直接依赖维护在 `rag-service/requirements.in`，完整版本和下载哈希锁定在自动生成的 `rag-service/requirements.txt`。安装和 CI 必须使用锁文件：

```bash
uv venv .venv
uv pip install --require-hashes -r rag-service/requirements.txt
```

需要升级依赖时只编辑 `requirements.in`，不要手工修改 `requirements.txt`。在项目根目录重新生成并审计锁文件：

```bash
npm run rag:lock
npm run rag:audit
```

`rag:lock` 使用 `uv pip compile --generate-hashes` 重新解析全部传递依赖；`rag:audit` 同时执行已知漏洞扫描和哈希锁可安装性检查。更新锁文件后还应运行完整测试。

### 环境变量

先复制根目录 `.env.example` 为 `.env`，替换所有 `replace-with-*` 基础设施凭据；再复制 `server/.env.example` 到 `server/.env`，复制 `rag-service/.env.example` 到 `rag-service/.env`。示例文件中的占位符不能作为实际凭据使用。

每个密码、JWT 和运维令牌都应独立生成，不要复用：

```bash
openssl rand -hex 32
```

`RAG_SERVICE_TOKEN` 是例外：它是服务间共享令牌，只生成一次，并把同一个值分别写入 `server/.env` 与 `rag-service/.env`。`METRICS_TOKEN` 必须单独生成。

复制 `server/.env.example` 到 `server/.env`，填写 GitHub OAuth 和模型密钥。
复制 `rag-service/.env.example` 到 `rag-service/.env`，填写 embedding API 密钥。

关键变量：

```env
DATABASE_URL=postgres://replace-with-postgres-user:replace-with-generated-postgres-password@127.0.0.1:5432/chatllm
TRUST_PROXY_HOPS=0
S3_ENDPOINT=http://127.0.0.1:9000
S3_ACCESS_KEY=replace-with-minio-access-key
S3_SECRET_KEY=replace-with-generated-minio-secret-key
S3_BUCKET=documents
S3_REGION=us-east-1
RAG_SERVICE_URL=http://localhost:8000
RAG_SERVICE_TOKEN=
RAG_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
RAG_CLEANUP_TIMEOUT_MS=10000
FILE_QUEUE_INGEST_TIMEOUT_MS=300000
FILE_QUEUE_STALE_AFTER_MS=900000
RAG_EVAL_QUEUE_STALE_AFTER_MS=900000
RAG_EVAL_CASE_TIMEOUT_MS=60000
RAG_EVAL_RUN_TIMEOUT_MS=1800000
RAG_EVAL_MAX_CASES_PER_DATASET=500
RAG_EVAL_MAX_CASES_PER_RUN=500
MAX_DOCUMENT_BYTES=104857600
MAX_USER_STORAGE_BYTES=10737418240
MAX_USER_ACTIVE_UPLOAD_BYTES=1073741824
MULTIPART_UPLOAD_PART_SIZE_BYTES=16777216
MULTIPART_UPLOAD_URL_EXPIRES_SECONDS=900
MULTIPART_UPLOAD_SESSION_TTL_MS=86400000
RAG_DB_POOL_MAX=10
RAG_DB_POOL_TIMEOUT_MS=5000
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
EMBEDDING_PROVIDER=compatible
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=https://llm-ro9cl3th56gnvkzo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMENSION=1024
```

`HTTP_PROXY` / `HTTPS_PROXY` 是可选项。只有当浏览器能打开 GitHub、但后端 OAuth callback 报 `fetch failed` 或 `Connect Timeout Error` 时才需要配置，值应与你本机系统代理端口一致。

`EMBEDDING_PROVIDER=local` 只建议用于本地 smoke / 开发验证。生产或真实语义检索仍应使用千问百炼等供应商的兼容 embedding 接口。

### Markdown 索引升级

当前 Chunk 策略为 `markdown-v4:parent-child:metadata-embedding:chunk1000-overlap100`。升级已有环境后必须重新摄取旧 Markdown，才能让 PostgreSQL、Milvus、Elasticsearch 与 Neo4j 同步使用新的 Parent-child 元数据和文件名/标题向量。先预览，再分批入队：

```powershell
npm --prefix server run reindex:markdown -- -- --limit 100
npm --prefix server run reindex:markdown -- -- --force --project-space-id <uuid> --limit 100
npm --prefix server run reindex:markdown -- -- --force --confirm-all --limit 100
```

命令默认是 dry-run。这里连续两个 `--` 分别结束外层 npm 与脚本参数解析，不能省略，否则 npm 会吞掉 `--limit` / `--force`。实际重摄取必须显式添加 `--force`；项目级操作必须带 `--project-space-id <uuid>`，全库操作必须再带 `--confirm-all`，旧 `--apply` 会被拒绝。它只选择稳定态的 `.md` / `.markdown`，随后复用 PostgreSQL 状态、BullMQ 投递和现有摄取 Worker，不直接写外部索引。Worker 完成后可重复预览直到数量为 0。不要把旧 `chatllm_chunks` 直接改名冒充新 schema；新 mapping 不兼容时服务会明确要求使用新索引并重新摄取 Markdown。

可选语义 Query Rewrite 默认关闭。确定性模式已支持连续省略追问、条件/比较/序号追问并最多回溯三个用户问题；只有同时配置 `QUERY_REWRITE_ENABLED=true`、API key、base URL 与 model 才会调用兼容模型。模型必须返回严格 JSON，新增或丢失精确 ID、裸数字、版本、文件名、引号短语或否定约束时会安全退回确定性改写。RRF 后的本地 `local-evidence-v2` 会综合正文、标题路径、精确标记、短语邻近度、答案承载和同源重复抑制；它不冒充 Cross-encoder，完整配置 `/rerank` Provider 后才执行语义精排。评测用例可进一步标注 Chunk ID、逐字证据、可回答性、Graph 三元组和人工三维评分；未标注或未配置能力一律显示 `N/A`。系统聚合 P50/P95 延迟与回答/Judge Token，用于容量分析；未配置供应商价格时不计算或伪造货币成本。

RAG 回答默认 fail-closed：检索已触发但没有任何可用证据时，服务返回确定性的“证据不足”拒答并跳过答案模型；没有来源的事实性回答不会获得 Grounding 成功分。Elasticsearch 故障不再伪装成“0 条结果”，BM25 会明确标记降级并回退 PostgreSQL；若所有规划查询都不可用，链路返回检索错误并停止生成。大文件会先流式写入临时 staging，完整校验字节数、SHA-256、UTF-8 与 Markdown 分块成功后才替换旧索引，损坏对象不会清空当前可服务知识。

评测运行会冻结 `execution_snapshot`（数据集、检索参数、生成模型、超时、知识与各索引版本），并绑定创建时最近一次 completed/partial 运行作为 paired baseline。报告提供逐 Case 配对差值、确定性 bootstrap 95% 置信区间和 tags/category/difficulty 切片；每个 Case 独立超时并可取消，下游单 Case 卡住不会拖垮整批。`RAG_EVAL_MAX_CASES_PER_DATASET` 与 `RAG_EVAL_MAX_CASES_PER_RUN` 默认均为 500、最大 5000，后者不能高于前者。

Graph LLM 抽取默认关闭。启用时必须显式配置 `GRAPH_EXTRACTION_ENABLED=true` 及兼容 API 的 key、base URL 和 model，推荐成套使用 `GRAPH_EXTRACTION_*`，避免隐式复用 Judge 配置造成供应商错配。当前只支持 `GRAPH_ONTOLOGY_VERSION=core-v1`。系统保留来源中的开放实体类型标签和关系谓词，但存储与遍历仍映射到受控安全大类；未配置或单个 Chunk 抽取失败时使用降权的规则 fallback，因此这不是自动生成无限本体的知识图谱。

`npm run check:env` 会对所有显式启用的高级能力执行成套配置校验：Query Rewrite、Reranker、Graph 抽取、LLM Judge 缺少任一 provider 字段都会失败；`REDIS_CACHE_ENABLED=true` 时必须提供与队列 `REDIS_URL` 分离的 `CACHE_REDIS_URL`。没有真实凭证时应保持这些开关关闭，不能用占位值“硬启用”。启用前后应在同一数据集上各运行一次评测，使用自动绑定的 paired baseline 判断收益，并结合 95% CI 与切片结果检查回归。

上传配额按用户串行核算：`MAX_DOCUMENT_BYTES` 限制单文件声明大小，`MAX_USER_STORAGE_BYTES` 限制已落盘总量，`MAX_USER_ACTIVE_UPLOAD_BYTES` 限制进行中上传预留量。初始化上传时先写入 `reserved_bytes`；对象大小与元数据校验成功后，预留量才转换为实测 `storage_bytes`；取消或删除时必须在外部对象确认不存在后才释放 `reserved_bytes`，避免并发上传绕过配额。

### 访问地址

- 前端：`http://localhost:5173`
- 后端健康检查：看 `server/.env` 的 `PORT`，默认是 `http://localhost:3000/health`
- RAG 健康检查：`http://localhost:8000/health`
- MinIO Console：`http://localhost:9001`
- Attu / Milvus 管理界面：`http://localhost:3001`

Docker 首次创建空 PostgreSQL 数据库时会使用 `server/migrations/0001_init.sql` 初始化基础表结构。NestJS 后端启动时会自动执行 `server/migrations` 目录里尚未应用的 SQL 迁移，因此已有本地数据库也会补齐后续表结构。

删除文件、项目空间或账户是跨 PostgreSQL、MinIO、Milvus、Elasticsearch 与 Neo4j 的持久化清理流程。删除接口返回 `202 Accepted` 后，资源进入 `deletion_status=pending` 或 `deleting`，并不表示外部对象已经全部删除；运维端应持续观察队列，失败任务可在租约恢复后重试。

部署 `server/migrations/0025_security_sessions_rate_limits.sql` 前必须备份 PostgreSQL。该迁移会把 refresh session 表重写为仅存储 SHA-256 token hash，并删除原始 token 列；旧版本应用不能回滚读取原始 token，因此不能依靠旧二进制执行数据库回滚，应保留备份并采用应用与迁移一起向前恢复的方案。

### 运维健康检查

后端 `/health/ready` 验证 PostgreSQL、Redis 与已鉴权的 RAG readiness；RAG `/health/ready` 验证 PostgreSQL、Milvus、Elasticsearch、Neo4j，并返回 Query Rewrite、Reranker、Graph 抽取、Redis 检索缓存、Judge 和 Markdown 索引版本的真实模式。历史 Markdown 仍使用旧 Chunk 策略时返回 `stale_file_count/stale_chunk_count/reindex_required` 并标记 capability `degraded`，但不会把仍可服务的进程判成 503。受 `METRICS_TOKEN` 保护的 `/health/queues` 额外公开 `cleanup`、`ingestion_leases` 与 `eval_leases` 状态。清理任务耗尽重试次数或任一活动租约过期时，该端点返回 `503` 与 `degraded`，响应不包含下游原始错误。

统一检查会自动从 `server/.env` / `rag-service/.env` 读取共享令牌，也可以使用 `OPS_RAG_TOKEN` 与 `OPS_METRICS_TOKEN` 显式覆盖：

```powershell
$env:OPS_RAG_TOKEN = '<与 RAG_SERVICE_TOKEN 相同的值>'
$env:OPS_METRICS_TOKEN = '<METRICS_TOKEN 的值>'
npm run check:ops
```

`check:ops` 会校验 readiness 响应结构和各依赖状态，而不只是判断 HTTP 200；报告会直接显示 Redis、Milvus、Elasticsearch、Neo4j、可选模型模式和陈旧 Markdown 数。需要验证真实 Markdown 的对象存储、PostgreSQL、Milvus、Elasticsearch、Neo4j 写入、检索与清理时，再运行 `npm run rag:smoke`。

容量配置可单独检查；企业配置可用严格模式把警告作为失败处理：

```powershell
npm run check:capacity
$env:CAPACITY_PROFILE = 'enterprise'
$env:CAPACITY_STRICT = 'true'
npm run check:capacity
```

### 单独启动调试

平时不需要分开启动。只有调试单个服务时才使用下面的命令：

```bash
cd D:\project\chatLLM
npm run dev:infra

cd D:\project\chatLLM\server
npm run dev

cd D:\project\chatLLM
npm run dev:rag

cd D:\project\chatLLM\client
npm run dev
```

前端默认通过 Vite proxy 访问 `/api`，会优先读取 `server/.env` 里的 `BACKEND_URL` / `PORT`。

`npm run dev:rag` 会优先使用项目根目录 `.venv` 里且能导入 RAG 依赖的 Python，避免系统全局 Python 依赖污染影响 RAG 服务；如需强制指定解释器，可以设置 `RAG_PYTHON`。

## 主要功能

- GitHub OAuth 登录
- JWT access token + refresh token rotation
- Project Spaces：按项目组织会话、文件和 RAG 检索上下文
- ChatGPT 风格流式对话
- 大历史会话按 cursor 分页加载，避免一次性拉取全部消息
- 会话创建、重命名、删除
- 会话可移动到不同 Project Space
- 消息搜索
- Markdown 文件分片上传、直传 MinIO、断点续传和完整性校验
- 文件处理失败后可重试
- Usage 页面可查看文档处理队列、失败原因和重试状态
- MinIO 文档存储
- RAG 文档解析、切块、embedding、Milvus 向量检索、Elasticsearch BM25 检索、Neo4j 图谱检索
- 本地 RAG smoke 可不依赖外部 embedding 额度完成 ingest / retrieve 闭环
- Agentic RAG 查询规划、证据复用缓存、引用校验、trace 展示和质量信号
- RAG 评测中心可查看历史 RAG 运行、来源命中、弱证据和质量趋势
- 知识图谱可查看文档实体关系，并定位到原文证据片段
- 对话回答展示引用来源、片段编号、相似度、摘要和 RAG trace
- 使用追踪页面可按会话和文档查看用户使用情况
- 个人画像中心可基于历史提问生成、编辑、隐藏、恢复和删除用户画像记录
- 个人资料和主题设置

## 产品边界

ChatLLM 的定位是面向用户的 AI 对话入口和知识工作台：核心能力是对话体验、项目空间、Markdown 知识库、Agentic RAG 检索、引用溯源、知识图谱、质量评测、使用追踪和个人画像。它不承担通用工作流编排平台的职责，复杂工具流、节点编排和跨应用自动化更适合放在独立的 `agent-flow` 项目中。

## 数据说明

本项目当前不迁移旧 Supabase 数据。新环境从空 PostgreSQL 数据库启动。

业务数据存储在 PostgreSQL：

- `users`
- `sessions`
- `project_spaces`
- `conversations`
- `messages`
- `files`
- `file_chunks`

源文件存储在 MinIO `documents` bucket。

向量数据存储在 Milvus `document_chunks` collection。

BM25 检索数据存储在 Elasticsearch `chatllm_chunks_v2` index；mapping schema 为 `markdown-fields-v2`。

实体关系和证据定位数据存储在 Neo4j。
