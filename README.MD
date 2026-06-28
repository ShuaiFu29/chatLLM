# DocuMind - 智能文档大脑

DocuMind 是一个前后端分离的 AI 聊天工作台。用户可以通过 GitHub OAuth 登录，把文件、会话和基础 RAG 检索组织到 Project Spaces 中，并在对话中查看引用来源。

当前架构已经移除 Supabase，改为本地 Docker Compose 栈：

- React + Vite 前端
- Express + TypeScript 后端
- PostgreSQL 业务数据库
- MinIO 文件存储
- Python FastAPI RAG 服务
- Milvus 向量数据库

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
  Server -->|Streaming chat completion| LLM["DeepSeek/OpenAI-compatible API"]
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
- OpenAI-compatible Embeddings API
- PostgreSQL chunk metadata
- MinIO source document download
- Milvus vector storage and retrieval

## 本地启动

依赖和 `.env` 配置准备好后，优先在项目根目录使用一条命令启动：

```bash
cd D:\project\chatLLM
npm run dev
```

这个命令会自动检查配置、启动 Docker 基础设施，并同时启动 Express 后端、Python RAG 服务和 React 前端。

如果使用 pnpm，也可以执行：

```bash
cd D:\project\chatLLM
pnpm run dev
```

### 环境变量

复制 `server/.env.example` 到 `server/.env`，填写 GitHub OAuth 和模型密钥。
复制 `rag-service/.env.example` 到 `rag-service/.env`，填写 embedding API 密钥。

关键变量：

```env
DATABASE_URL=postgres://chatllm:chatllm@localhost:5432/chatllm
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=documents
RAG_SERVICE_URL=http://localhost:8000
```

### 访问地址

- 前端：`http://localhost:5173`
- 后端健康检查：看 `server/.env` 的 `PORT`，默认是 `http://localhost:3002/health`
- RAG 健康检查：`http://localhost:8000/health`
- MinIO Console：`http://localhost:9001`
- Attu / Milvus 管理界面：`http://localhost:3001`

Docker 首次创建空 PostgreSQL 数据库时会使用 `server/migrations/0001_init.sql` 初始化基础表结构。Express 后端启动时会自动执行 `server/migrations` 目录里尚未应用的 SQL 迁移，因此已有本地数据库也会补齐后续表结构。

### 单独启动调试

平时不需要分开启动。只有调试单个服务时才使用下面的命令：

```bash
cd D:\project\chatLLM
npm run dev:infra

cd D:\project\chatLLM\server
npm run dev

cd D:\project\chatLLM\rag-service
uvicorn main:app --reload --host 0.0.0.0 --port 8000

cd D:\project\chatLLM\client
npm run dev
```

前端默认通过 Vite proxy 访问 `/api`，会优先读取 `server/.env` 里的 `BACKEND_URL` / `PORT`。

## 主要功能

- GitHub OAuth 登录
- JWT access token + refresh token rotation
- Project Spaces：按项目组织会话、文件和 RAG 检索上下文
- ChatGPT 风格流式对话
- 会话创建、重命名、删除
- 会话可移动到不同 Project Space
- 消息搜索
- Markdown 文件分片上传和断点续传
- 文件处理失败后可重试
- MinIO 文档存储
- RAG 文档解析、切块、embedding、Milvus 检索
- 对话回答展示基础引用来源、片段编号、相似度和摘要
- 个人资料和主题设置

## 产品边界

chatLLM 的定位是面向用户的聊天入口和项目知识工作台：管理会话、文件、Project Spaces、基础检索和回答引用。后续如果开发 `agent-flow` 和 `agentic-rag`，建议把工作流编排、工具调用、多步规划、多跳检索、复杂 rerank/trace 等能力放到那两个项目中，避免三个项目高度重合。

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
