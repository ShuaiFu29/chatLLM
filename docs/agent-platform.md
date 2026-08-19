# ChatLLM 用户可配置 Agent 平台

## 最终能力

用户可以在 Agent 中心完成以下操作：

- 创建、编辑、复制、发布、停用和删除 Agent。
- 为 Agent 配置名称、头像、可见范围、工作区、系统指令和欢迎语。
- 选择支持 Tool Calling 的模型，并配置 temperature、最大迭代数、最长运行时间和最大输出 Token。
- 选择无记忆、会话记忆、用户画像记忆或项目记忆。
- 要求 Markdown 输出，或要求遵循自定义 JSON Schema 的 JSON 对象输出。
- 独立选择每个内置或自定义工具；未绑定的工具不会暴露给模型。
- 设置 `never`、`writes` 或 `always` 审批策略。

审批策略的实际含义是：`never` 只允许只读工具，写入和高风险工具会被拒绝；`writes` 自动执行只读工具、对写入/高风险工具审批；`always` 对所有工具审批。

会话可以绑定一个已发布 Agent，也可以随时切回普通聊天。Run 固定使用开始运行时的已发布版本快照，因此编辑草稿不会改变正在运行或已经完成的 Run。

Agent 中心的“运行记录”页签可以查看全部或指定 Agent 的历史 Run，展开完整 Step、审批、证据核验摘要和错误详情，并取消仍处于排队、运行或等待审批状态的 Run。

## Agent 与 Agentic RAG 的关系

Agentic RAG 仍由原有 RAG 服务负责查询规划、混合检索、图谱检索、证据验证、引用和质量评测。Agent 运行时不重新实现 RAG；它只把 `agentic_rag` 注册成一个可选工具。

未绑定 `agentic_rag` 的 Agent 不会访问 RAG。普通聊天的原有 RAG 开关和链路不受 Agent 平台影响。

## 工具类型

内置工具包括：

- `agentic_rag`
- `list_documents`
- `read_document_excerpt`
- `query_knowledge_graph`
- `search_conversation_history`
- `get_project_context`
- `calculator`
- `current_time`

用户还可以配置：

- HTTP 工具：GET/POST/PUT/PATCH/DELETE、路径参数、Query/JSON Body、固定公开请求头、响应路径和 JSON Schema 输入。
- 远程 MCP 工具：使用 Streamable HTTP JSON-RPC，完成初始化、Session、`tools/call` 和 Session 关闭，并兼容 JSON 或 SSE 响应。

自定义工具的远端主机必须由部署方通过 `AGENT_HTTP_ALLOWED_HOSTS` 或 `AGENT_MCP_ALLOWED_HOSTS` 明确允许。默认空白名单代表禁止所有自定义远端调用。

## Run 生命周期

一个 Agent 回合按以下状态运行：

1. 写入用户消息并创建 `agent_runs`；如果用户在 Run 行写入前明确停止，会为这条用户消息保留一次短时取消意图，不会留下一个“幽灵”运行。
2. 固定已发布 Agent 版本，构建系统指令、记忆和允许使用的工具定义。
3. 调用模型；模型可以给出最终回答，也可以请求一个或多个工具。
4. 每次模型调用、工具调用、工具结果、审批和最终回答写入 `agent_steps`。
5. Run 创建时同时创建持久化助手占位；工具事件通过 SSE 实时显示，SSE 断线或页面重载后聊天页会从数据库恢复时间线、审批和最终结果。
6. 模型在迭代、时间和输出预算内继续运行，直到生成最终回答或失败/取消。

最终用户与助手消息继续保存在原 `messages` 表中。内部模型消息和工具消息只保存在 Run/Step 表，避免污染消息搜索、导出和原有 RAG Trace。

## 审批

需要审批的工具会创建 `agent_approvals`，将 Run 置为 `waiting_approval`，并在聊天时间线展示工具名称、风险等级和调用参数。

- 批准：记录决定，执行原工具，然后继续同一个 Agent 循环。
- 拒绝：记录决定，把拒绝结果作为工具结果交回模型，然后继续生成安全回答。
- 取消或运行超时：等待失效，Run 进入取消或失败状态。SSE 连接断开不会自动取消 Agent；用户需要通过聊天中的停止操作或运行记录中的取消操作显式终止它。

审批只允许 Run 所属用户提交，并且只能决定一次。审批决定写入数据库，执行进程会轮询数据库状态，因此 API 请求可以落到不同的服务实例；服务进程重启后仍不会自动重放未完成的模型/工具副作用，维护任务会在超过运行自身最大时长并额外保留 60 秒缓冲后将不可恢复的活动 Run 标记为失败。

## 安全边界

- 工具凭据使用 `AGENT_TOOL_ENCRYPTION_KEY` 派生的 AES-256-GCM 密钥认证加密，API 不返回明文。
- URL 禁止内嵌用户名或密码；固定公开请求头禁止 Authorization/Cookie。
- HTTP/MCP 工具的 URL 不允许使用疑似凭据的 Query 参数或 Fragment；凭据必须放在加密的 secrets 配置中。
- HTTP/MCP 请求禁止重定向，并受域名白名单、超时和最大响应体限制。
- JSON Schema 子集在工具执行前验证模型参数。
- Agent 输出 Schema 和自定义工具输入 Schema 限制为最大 64 KiB，并限制嵌套深度，避免配置本身耗尽运行资源。
- 工具结果被标记为不可信数据，并有长度上限，系统指令明确禁止遵循工具输出中的提示注入。
- 每个工具执行前都会预留最小工具结果上下文；如果当前回合无法容纳结果，会在执行外部副作用前失败。
- 模型请求会把消息、工具定义和工具结果一起计入上下文预算；会优先丢弃最旧的可选会话记忆，仍超出模型上下文时明确失败，不把 Provider 的上下文错误伪装成成功回答。
- 模型流必须包含非空的 `finish_reason` 才会被视为完整回合；Provider 在传输中提前断开时不会把残缺文本或残缺工具参数当成成功结果。
- HTTP 工具的凭据查询参数优先于模型参数；配置的响应路径不存在、MCP 返回 `isError=true` 都会被记录为工具失败。
- HTTP 工具 URL 中预先配置的 Query 参数也优先于模型参数，可用于固定租户或范围；需要动态传入的参数应通过输入 Schema 配置。
- Agent 只能绑定用户有权访问且当前启用的工具；仍被当前或已发布 Agent 版本绑定的自定义工具不能删除。
- 自定义工具只能绑定到全局 Agent，或绑定到同一项目空间的 Agent；创建、编辑和每次运行都会再次检查项目作用域。
- 不支持任意本地 Shell、任意代码执行或访问部署方未授权的网络地址。

## 部署配置

在 `server/.env` 中配置：

```env
# openssl rand -hex 32
AGENT_TOOL_ENCRYPTION_KEY=

# 逗号分隔；支持 *.example.com，默认不允许任何主机
AGENT_HTTP_ALLOWED_HOSTS=api.example.com
AGENT_MCP_ALLOWED_HOSTS=mcp.example.com

# HTTP 与 MCP 单个响应的最大字节数
AGENT_HTTP_MAX_RESPONSE_BYTES=262144

# Agent 资源配额（可按部署规模调整）
AGENT_MAX_AGENTS_PER_USER=100
AGENT_MAX_TOOLS_PER_USER=100
AGENT_MAX_VERSIONS_PER_AGENT=100
AGENT_MAX_ACTIVE_RUNS_PER_USER=3
AGENT_MAX_SOURCES=50
AGENT_MAX_SOURCE_BYTES=524288
AGENT_MAX_TOKEN_BUDGET=100000
AGENT_MAX_STEP_PAYLOAD_BYTES=262144
```

Agent 还会按所选模型的已知上下文窗口限制 `max_output_tokens` 和每一轮请求；例如 `moonshot-v1-8k` 不允许把输出预算配置到整个上下文窗口以上。

使用自定义工具前必须配置加密密钥和对应白名单。密钥轮换需要先设计密文重加密流程；直接替换密钥会使已有凭据无法解密。

## 明确不包含

- 可视化节点/DAG 工作流编辑器。
- 定时或无人值守 Agent 任务。
- 跨进程重启后自动重放一个暂停中的工具副作用。
- 本地 Shell、Python 或用户上传代码执行。
- 未经部署方白名单授权的任意互联网或内网访问。
- Provider 不支持的原生能力（例如没有 Tool Calling 的推理模型）不会被模拟；这类模型不能作为带工具的 Agent 发布。
