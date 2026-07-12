# ChatLLM - AI 聊天与 Agentic RAG 知识工作台

ChatLLM 是一个前后端分离的 AI 聊天与 Agentic RAG 知识工作台。用户可以通过 GitHub OAuth 登录，把会话、Markdown 文档、项目空间、检索引用、RAG 质量评测和使用追踪组织在同一个工作台里。

当前架构已经移除 Supabase，改为本地 Docker Compose 栈：

- React + Vite 前端
- Express + TypeScript 后端
- PostgreSQL 业务数据库
- MinIO 文件存储
- Python FastAPI RAG 服务
- Milvus 向量数据库
- Elasticsearch BM25 检索
- Neo4j 知识图谱

## 系统架构

```mermaid
flowchart LR
  Client["React/Vite Client"] -->|HTTP + Cookies| Server["Express API Server"]
  Server -->|SQL| Postgres["PostgreSQL"]
  Server -->|S3 API| MinIO["MinIO Documents Bucket"]
  Server -->|/ingest /retrieve /cleanup-file| Rag["Python RAG Service"]
  Rag -->|SQL metadata/chunks| Postgres
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
  server/        Express 后端
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

- Express 5
- TypeScript
- PostgreSQL via `pg`
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
- Agentic query planning, trace, evidence verification, and RAG evaluation support

## 本地启动

依赖和 `.env` 配置准备好后，优先在项目根目录使用一条命令启动：

```bash
cd D:\project\chatLLM
npm run dev
```

这个命令会自动检查配置和本地端口占用，启动 Docker 基础设施，并同时启动 Express 后端、Python RAG 服务和 React 前端。

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
DATABASE_URL=postgres://replace-with-postgres-user:replace-with-generated-postgres-password@localhost:5432/chatllm
TRUST_PROXY_HOPS=0
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=replace-with-minio-access-key
S3_SECRET_KEY=replace-with-generated-minio-secret-key
S3_BUCKET=documents
S3_REGION=us-east-1
RAG_SERVICE_URL=http://localhost:8000
RAG_SERVICE_TOKEN=
RAG_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
RAG_CLEANUP_TIMEOUT_MS=10000
FILE_QUEUE_INGEST_TIMEOUT_MS=10000
FILE_QUEUE_STALE_AFTER_MS=900000
RAG_EVAL_QUEUE_STALE_AFTER_MS=900000
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

上传配额按用户串行核算：`MAX_DOCUMENT_BYTES` 限制单文件声明大小，`MAX_USER_STORAGE_BYTES` 限制已落盘总量，`MAX_USER_ACTIVE_UPLOAD_BYTES` 限制进行中上传预留量。初始化上传时先写入 `reserved_bytes`；对象大小与元数据校验成功后，预留量才转换为实测 `storage_bytes`；取消或删除时必须在外部对象确认不存在后才释放 `reserved_bytes`，避免并发上传绕过配额。

### 访问地址

- 前端：`http://localhost:5173`
- 后端健康检查：看 `server/.env` 的 `PORT`，默认是 `http://localhost:3000/health`
- RAG 健康检查：`http://localhost:8000/health`
- MinIO Console：`http://localhost:9001`
- Attu / Milvus 管理界面：`http://localhost:3001`

Docker 首次创建空 PostgreSQL 数据库时会使用 `server/migrations/0001_init.sql` 初始化基础表结构。Express 后端启动时会自动执行 `server/migrations` 目录里尚未应用的 SQL 迁移，因此已有本地数据库也会补齐后续表结构。

删除文件、项目空间或账户是跨 PostgreSQL、MinIO、Milvus、Elasticsearch 与 Neo4j 的持久化清理流程。删除接口返回 `202 Accepted` 后，资源进入 `deletion_status=pending` 或 `deleting`，并不表示外部对象已经全部删除；运维端应持续观察队列，失败任务可在租约恢复后重试。

部署 `server/migrations/0025_security_sessions_rate_limits.sql` 前必须备份 PostgreSQL。该迁移会把 refresh session 表重写为仅存储 SHA-256 token hash，并删除原始 token 列；旧版本应用不能回滚读取原始 token，因此不能依靠旧二进制执行数据库回滚，应保留备份并采用应用与迁移一起向前恢复的方案。

### 运维健康检查

后端 `/health/ready` 验证 PostgreSQL 与已鉴权的 RAG readiness；受 `METRICS_TOKEN` 保护的 `/health/queues` 额外公开 `cleanup`、`ingestion_leases` 与 `eval_leases` 状态。清理任务耗尽重试次数或任一活动租约过期时，该端点返回 `503` 与 `degraded`，响应不包含下游原始错误。

统一检查会自动从 `server/.env` / `rag-service/.env` 读取共享令牌，也可以使用 `OPS_RAG_TOKEN` 与 `OPS_METRICS_TOKEN` 显式覆盖：

```powershell
$env:OPS_RAG_TOKEN = '<与 RAG_SERVICE_TOKEN 相同的值>'
$env:OPS_METRICS_TOKEN = '<METRICS_TOKEN 的值>'
npm run check:ops
```

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

BM25 检索数据存储在 Elasticsearch `chatllm_chunks` index。

实体关系和证据定位数据存储在 Neo4j。
