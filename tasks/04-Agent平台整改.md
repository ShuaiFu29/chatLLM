# Agent 平台：能力评估与整改

本文说明 Agent **现在能做什么**、**设计上故意不能做什么**、以及要把「可配置」做成「可演示/可预发布」必须补的闭环。缺陷条目引用 [02](./02-P1-必须修复.md) / [03](./03-P2-P3-缺陷清单.md)。产品边界原文见 `docs/agent-platform.md`。

## 1. 产品定位

ChatLLM 的 Agent 是 **绑在对话上的多轮 Tool Calling Agent**：

- 用户配置能力、模型、权限
- 运行时由模型在预算内选择工具
- Agentic RAG、图谱、读文档都是 **可选工具**
- 普通聊天可完全不绑定 Agent

它 **不是**：AutoGPT、LangGraph DAG、定时任务系统、Computer Use、多 Agent 协作。

## 2. 已实现能力（应保持）

### 2.1 配置与版本

- 创建、编辑、复制、发布、停用、删除
- 名称、头像、可见范围（private / project）、工作区、系统指令、欢迎语、建议问题
- 仅允许声明了 Tool Calling 的模型发布带工具 Agent
- temperature、`max_iterations`（默认 6）、`max_duration_ms`、`max_output_tokens`（受模型上下文窗口限制）
- 记忆：`none` / `conversation`（最近约 20 条）/ `user`（画像）/ `project`（项目名与描述）
- 输出：Markdown 或自定义 JSON Schema
- 工具逐个绑定；未绑定不暴露给模型
- 审批：`never` / `writes` / `always`
- Run **固定已发布版本快照**，改草稿不影响进行中或历史 Run
- 配额：每用户 Agent/工具/版本数、同时活跃 Run 数、step payload、token budget 等（见 `server/.env.example`）

### 2.2 内置工具（全部只读）

| key | 作用 | 风险 | 需要项目 |
|-----|------|------|----------|
| `agentic_rag` | 调用现有 RAG：规划、混合检索、图谱证据、质量信号 | read | 是 |
| `list_documents` | 列工作区文件与摄取状态 | read | 是 |
| `read_document_excerpt` | 读有界索引片段 | read | 是 |
| `query_knowledge_graph` | 查实体关系与来源 | read | 是 |
| `search_conversation_history` | 搜当前用户历史消息 | read | 否 |
| `get_project_context` | 项目名、描述、资源计数 | read | 是 |
| `calculator` | 受控算术，不执行代码 | read | 否 |
| `current_time` | IANA 时区当前时间 | read | 否 |

写操作与高风险操作 **只能** 通过自定义 HTTP / 远程 MCP。每轮最多 4 次工具调用；工具结果截断并标记为不可信数据。

### 2.3 自定义工具安全模型（应保持 fail-closed）

- 凭据 AES-256-GCM，API 不回说明文
- URL 禁止内嵌用户名密码；公开头禁止 Authorization/Cookie
- 疑似凭据的 Query / Fragment 不允许出现在 URL 里
- DNS pin + 私网拦截 + 禁止重定向 + 超时 + 最大响应体
- 默认空白名单 = 禁止全部自定义远端
- 自定义工具只能绑全局 Agent，或同一项目空间的 Agent；运行时再检 scope
- 仍被当前或已发布版本绑定的自定义工具不能删除

### 2.4 运行时质量措施（应保持）

- 预 Run 取消 intent，避免「停止发生在 insert Run 之前」留下幽灵运行
- 持久化助手占位；内部 tool/model 消息进 `agent_steps`，不污染 `messages` 搜索/导出
- 审批落库，执行进程轮询，支持多实例
- 上下文预算：优先丢最旧可选会话记忆；仍超限则明确失败
- 使用知识工具后做 grounding，不足则拒答
- 维护任务在超过 Run 最大时长 + 60s 后将不可恢复的活动 Run 标失败
- **进程重启不自动重放工具副作用**（有意）

## 3. 能力评级（按使用场景）

| 场景 | 水平 | 说明 |
|------|------|------|
| 知识问答 / 查文档 / 查图谱的项目助手 | 可用 | 复用成熟 RAG，最能打的演示路径 |
| 受控 HTTP/MCP 内部 API | 骨架扎实 | 取决于白名单、审批、密钥 |
| 聊天里长时间跑、再生、断线 | 差 | P1 生命周期 |
| 无人值守 / 定时 / DAG | 不做 | 不要开需求当 bug |
| 多 Agent、浏览器、本地代码 | 不做 | |

**配置面约 7.5/10，聊天产品闭环约 5.5–6/10。** 整改重点是闭环，不是再堆工具种类。

## 4. 必须整改的闭环（按用户路径）

### 4.1 聊天操作 × Run 生命周期

| 用户动作 | 今天 | 应该 |
|----------|------|------|
| 停止 | 调 cancel API（有） | 保持 |
| 重新生成 / truncate | 不取消旧 Run | `P1-TRUNCATE-RUN` |
| 删除消息 / 会话 | 需确认同样缺口 | 与 truncate 一并取消 |
| Continue | 当新 question 开新 Run | `P2-AGENT-CONTINUE` 直接禁用 |
| SSE 断开 | Run 继续（有意）但 UI 停住 | `P1-SSE-RECOVER` |
| 整页刷新 | 能从 DB 恢复 | 保持 |
| 运行记录看活跃 Run | 不自动刷新 | `P2-RUN-HISTORY-POLL` |

### 4.2 模型协议

- 流必须有非空 `finish_reason`（已有）
- **`length` + tool_calls 不得 execute**（`P1-LENGTH-TOOLS`）
- 无 response body 不得当成功（`P2-EMPTY-BODY`，聊天与 Agent 共用 provider）

### 4.3 审批体验

- 过期 ≠ 执行失败（`P2-APPROVAL-EXPIRED` + `P3-EXPIRED-UI`）
- 进入 `waiting_approval` 失败时不要创建悬挂 approval（`P3-WAITING-UPDATE`）

### 4.4 配置一致性

- 改 Agent `project_space_id` 与改 tool scope 的竞态（`P2-SCOPE-RACE`）
- 编辑器展示真实业务错误（`P2-EDITOR-ERRORS`）

## 5. 记忆能力的真实含义（避免产品误导）

| `memory_mode` | 实际注入 | 不是 |
|---------------|----------|------|
| `none` | 无会话历史 | — |
| `conversation` | 当前会话最近消息 | 不是长期记忆 |
| `user` | 用户画像 prompt 片段 | 不是全部历史对话 |
| `project` | 项目名称 + 描述 | **不是**「记住整个知识库」；读资料必须靠工具 |

整改文档/UI 文案时不要把 `project` 记忆宣传成自动读全库。知识访问靠绑定 `agentic_rag` 等工具。

## 6. 建议的「预发布」Agent 范围

修复 P1 之前：

- 演示只用 **只读内置工具**（尤其 `agentic_rag` + 读文档 + 图谱）
- 自定义 HTTP/MCP 仅在 staging、白名单收紧、审批 `writes` 或 `always` 下试用
- 不要演示：再生、Continue、拔网线、同时改 Agent 项目空间和工具空间

P1 + 关键测试完成后：

- 可把只读 Agent 作为会话默认选项之一
- 写工具仍建议默认 `writes` 审批，并监控 `AGENT_MAX_ACTIVE_RUNS_PER_USER`

## 7. 文档回写

修复后更新 `docs/agent-platform.md`：

1. 写清「聊天页如何从断线恢复」（依赖 `agent_run_status` 或等价条件）
2. 写清 truncate/再生会取消 Run
3. 写清 Agent 会话不支持 Continue（若采用该产品决定）
4. 审批过期的 error_code 与 UI 语义

不要在文档里继续承诺尚未实现的恢复行为。
