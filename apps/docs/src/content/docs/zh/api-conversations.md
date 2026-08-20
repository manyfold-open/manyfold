---
title: 通过 API 读取对话
description: 列出并回读你用 OpenAI 兼容 v1 API 创建的对话。
order: 6
---

# 通过 API 读取对话

用 [Chat Completions API](../api-chat/) 与 Agent 对话时，每一轮都会返回一个 `session_id`（既是
`x-session-id` 响应头，也是 `metadata.session_id`）。读取 API 让你重新列出这些对话并回读其中的消息——
适合做仪表盘、审计，或在你自己的界面里继续一段会话。

读取接口新增两个端点：

```text
GET /api/v1/conversations
GET /api/v1/conversations/{session_id}/messages
```

`session_id` 就是 `/api/v1/chat/completions` 通过 `x-session-id` 返回的同一个值；不存在单独的
conversation id。

## 开始之前

使用与聊天相同的 token。带 `chat.completions` scope（或 `api.full`）的 API token 即可读取你自己的
对话历史，无需额外 scope。读取操作**不**计入每月 API 请求配额。

## 列出对话

```sh
curl "https://api.manyfold.ai/api/v1/conversations?limit=20" \
  -H "Authorization: Bearer $MF_API_TOKEN"
```

响应是 OpenAI 风格的 list 信封：

```json
{
    "object": "list",
    "data": [
        {
            "object": "conversation",
            "id": "cts_...",
            "model": "agt_your_agent_id",
            "title": "Summarize this repository",
            "created_at": 1764547200,
            "updated_at": 1764547260
        }
    ],
    "first_id": "cts_...",
    "last_id": "cts_...",
    "has_more": false
}
```

- `model` 是该对话所属的 Manyfold agent id。
- `created_at` / `updated_at` 为 unix 秒。
- 加上 `?model=agt_your_agent_id` 可只列出单个 agent 的对话。
- 来源于渠道（Telegram、Slack 等）的对话不会被列出。

## 回读对话消息

```sh
curl "https://api.manyfold.ai/api/v1/conversations/cts_your_session_id/messages" \
  -H "Authorization: Bearer $MF_API_TOKEN"
```

每条消息都是 OpenAI 形状，便于 SDK 直接使用，同时附带一个 `content_blocks` 数组保留完整记录——
包括 coding agent 的工具调用与思考过程：

```json
{
    "object": "list",
    "data": [
        {
            "id": "...",
            "object": "message",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "Done. I updated three files." }
            ],
            "content_blocks": [
                { "type": "text", "text": "Done. I updated three files." },
                {
                    "type": "tool_call",
                    "toolName": "Bash",
                    "args": { "cmd": "ls" }
                }
            ],
            "model": "claude-sonnet-4-6",
            "created_at": 1764547260
        }
    ],
    "first_id": "...",
    "last_id": "...",
    "has_more": false
}
```

只需要文本时解析 `content`（标准 OpenAI parts 数组）；需要完整内容时读 `content_blocks`。

## 分页

两个端点共用相同的分页参数：

| 参数    | 说明                                                               |
| ------- | ------------------------------------------------------------------ |
| `limit` | 可选。1–100，默认 20。                                             |
| `after` | 可选。对象 id（上一页的 `first_id` / `last_id`），用于翻到下一页。 |
| `order` | 可选。`desc`（最新在前，默认）或 `asc`。                           |

当 `has_more` 为 `true` 时，把 `last_id` 作为 `after` 传入即可获取下一页。

## 作用域与可见性

- 绑定到单个 agent 的 token 只会自动列出该 agent 的对话；传入不一致的 `?model=` 会被拒绝。
- 请求不属于你的、来源于渠道的、或与绑定 token 的 agent 不符的对话，返回 `404`。

## 错误

错误采用与 Chat Completions API 相同的 OpenAI 风格：

```json
{
    "error": {
        "message": "conversation not found",
        "type": "invalid_request_error",
        "code": "conversation_not_found"
    }
}
```
