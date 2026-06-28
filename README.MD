# DocuMind - 智能文档大脑

DocuMind 是一个前后端分离的 RAG 应用。用户可以通过 GitHub OAuth 登录，上传 Markdown 文档，并基于个人知识库进行流式 AI 对话。

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

### 1. 启动基础设施

```bash
docker compose up -d postgres minio milvus-etcd milvus-minio milvus-standalone attu
```

PostgreSQL 会自动执行 `server/migrations/0001_init.sql` 初始化空库。

常用端口：

- PostgreSQL: `localhost:5432`
- MinIO API: `localhost:9000`
- MinIO Console: `localhost:9001`
- Milvus: `localhost:19530`
- Attu: `localhost:3001`

### 2. 配置后端环境变量

复制 `server/.env.example` 到 `server/.env`，填写 GitHub OAuth 和模型密钥。

关键变量：

```env
DATABASE_URL=postgres://chatllm:chatllm@localhost:5432/chatllm
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=documents
RAG_SERVICE_URL=http://localhost:8000
```

启动后端：

```bash
cd server
npm install
npm run dev
```

### 3. 配置 RAG 服务

复制 `rag-service/.env.example` 到 `rag-service/.env`，填写 embedding API 密钥。

启动 RAG 服务：

```bash
cd rag-service
pip install -r requirements.txt
python main.py
```

### 4. 启动前端

```bash
cd client
npm install
npm run dev
```

前端默认通过 Vite proxy 访问 `/api`，代理到 `http://localhost:3000`。

## 主要功能

- GitHub OAuth 登录
- JWT access token + refresh token rotation
- ChatGPT 风格流式对话
- 会话创建、重命名、删除
- 消息搜索
- Markdown 文件分片上传和断点续传
- MinIO 文档存储
- RAG 文档解析、切块、embedding、Milvus 检索
- 个人资料和主题设置

## 数据说明

本项目当前不迁移旧 Supabase 数据。新环境从空 PostgreSQL 数据库启动。

业务数据存储在 PostgreSQL：

- `users`
- `sessions`
- `conversations`
- `messages`
- `files`
- `file_chunks`

源文件存储在 MinIO `documents` bucket。

向量数据存储在 Milvus `document_chunks` collection。
