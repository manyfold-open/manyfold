---
title: 通过 API 与 Agent 通信
description: 使用 OpenAI 兼容的 Chat Completions API 与 Manyfold Agent 对话。
order: 6
---
当你希望外部服务、脚本或 OpenAI SDK 客户端与 Manyfold Agent 对话时，可以使用 OpenAI 兼容的 Chat Completions API。

v1 只暴露一个公开集成入口：

```text
POST /api/v1/chat/completions
```

这个接口用同一种请求格式连接 Claude Code、Codex、Gemini CLI、OpenClaw、Hermes、Dify、Langflow 等托管 Agent。

## 开始前

1. 在 Manyfold 中创建或选择一个 Agent。
2. 复制 Agent id。Agent id 以 `agt_` 开头。
3. 打开 **Settings -> API tokens**。
4. 创建一个带 `chat.completions` scope 的 API token。
5. 在 token 显示时复制保存。之后不会再次显示明文。

> **注意：** 只有可信内部客户端需要更广泛的 Manyfold API 权限时，才使用 `api.full`。普通聊天集成建议使用 `chat.completions`。

## Endpoint 和 model

托管产品使用：

```text
https://api.manyfold.ai/api/v1/chat/completions
```

如果你使用[自托管部署](/zh/docs/self-hosting/)，请把 origin 替换为自己的 API origin。

`model` 字段表示 Manyfold agent id，不是底层模型名称：

```json
{
    "model": "agt_your_agent_id",
    "messages": [{ "role": "user", "content": "总结这个仓库。" }]
}
```

## 非流式请求

```sh
curl https://api.manyfold.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $MF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agt_your_agent_id",
    "messages": [
      {
        "role": "system",
        "content": "你是一个简洁的工程助手。"
      },
      {
        "role": "user",
        "content": "列出这个项目接下来最重要的三件事。"
      }
    ]
  }'
```

响应使用 OpenAI Chat Completions 形状：

```json
{
    "object": "chat.completion",
    "model": "agt_your_agent_id",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "..."
            },
            "finish_reason": "stop"
        }
    ],
    "metadata": {
        "session_id": "cts_...",
        "assistant_message_id": "..."
    }
}
```

如果后续要继续同一个 Manyfold 会话，请保存 `metadata.session_id`。

Agent 在作答前的推理内容放在 `message.reasoning_content`，不会混进 `message.content`，所以 `content` 就是答案本身。没有推理内容时该字段不出现。

`finish_reason` 正常结束是 `stop`；如果 Agent 自身的内容审核替换了答案，则是 `content_filter`，此时 `content` 是替换后的答案。

## 流式请求

设置 `stream: true` 后，接口会返回 Server-Sent Events：

```sh
curl -N https://api.manyfold.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $MF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agt_your_agent_id",
    "stream": true,
    "stream_options": { "include_usage": true },
    "messages": [
      { "role": "user", "content": "写一段简短的发布说明。" }
    ]
  }'
```

每个事件格式如下：

```text
data: {"object":"chat.completion.chunk",...}

data: [DONE]
```

答案文本在 `choices[0].delta.content`；Agent 有推理内容时，推理放在 `choices[0].delta.reasoning_content`，各自单独累加即可。推理 chunk 通常比第一个答案 token 早得多，客户端渲染它就能更早看到进度。

流式响应也会带上 `x-session-id` header。如果后续要继续这个会话，请保存这个值。

## 继续会话

传入 `metadata.session_id` 可以继续已有 Manyfold 会话：

```json
{
    "model": "agt_your_agent_id",
    "metadata": {
        "session_id": "cts_existing_session_id"
    },
    "messages": [{ "role": "user", "content": "基于上一次结果继续。" }]
}
```

如果不传 `metadata.session_id`，Manyfold 会为本次请求创建新会话。如果要列出已创建的会话并回放其中的消息，见[用 API 读取会话](/zh/docs/api-conversations/)。

## 取消进行中的回合

Chat Completions 协议本身没有取消动作，直接断开 HTTP 流只会停止接收，Agent 仍在继续执行。要真正中断回合，请调用原生取消接口，`agentId` 就是你作为 `model` 使用的 agent id，session id 来自 `metadata.session_id`（或流式响应的 `x-session-id` header）：

```sh
curl -X POST \
  https://api.manyfold.ai/api/agents/agt_your_agent_id/sessions/cts_session_id/cancel \
  -H "Authorization: Bearer $MF_API_TOKEN"
```

- 该接口需要带 `chat:edit` scope 的 API token（`api.full` 也可以）。仅有 `chat.completions` scope 无法取消；如果集成需要中断回合，请给 token 追加 `chat:edit`。
- 返回 `204 No Content`，取消该会话最新的进行中 assistant 回合；没有进行中的回合时不做任何事。
- 被取消的回合以错误码 `cancelled_by_user` 结束，取消前已产出的内容会保留在会话里。
- 对 Dify agent，取消会同时停止所连 Dify 应用的生成，而不是让它在后台继续跑完。

## 发送文件

`user` 消息可以在文本之外携带图片和文件内容块（content part）。文件会附加到**最新的** user 消息上：

```sh
curl https://api.manyfold.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $MF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agt_your_agent_id",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "这张图里有什么？" },
          { "type": "image_url", "image_url": { "url": "https://example.com/diagram.png" } }
        ]
      }
    ]
  }'
```

- `image_url.url` 可以是公网 `https://` URL（由服务端抓取），也可以是 base64 `data:` URL（`data:image/png;base64,...`）。
- 文档使用 `file` 内容块：`{ "type": "file", "file": { "filename": "report.pdf", "file_data": "data:application/pdf;base64,..." } }`。
- 每条消息最多 10 个文件，单个 25 MB。base64 文件还会计入请求体大小上限（约 32 MB），较大文件请优先用 URL。
- 文件会作为原生附件发送给 Dify Agent，作为工作区文件发送给 coding agent（Claude Code、Codex 等）。对于 Dify Agent，所连接的 Dify 应用必须已开启文件上传。自托管部署需要配置 chat-upload 存储才能给 Dify 发送文件附件。

## OpenAI SDK 示例

多数 OpenAI 兼容客户端都支持覆盖 base URL：

```ts
import OpenAI from 'openai'

const client = new OpenAI({
    apiKey: process.env.MF_API_TOKEN,
    baseURL: 'https://api.manyfold.ai/api/v1'
})

const response = await client.chat.completions.create({
    model: 'agt_your_agent_id',
    messages: [{ role: 'user', content: '检查这个部署计划里的风险。' }]
})

console.log(response.choices[0]?.message?.content)
```

## 支持的请求字段

接口接受常见 Chat Completions 字段：

| 字段                                 | 说明                                                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| `model`                              | 必填。必须是 Manyfold agent id。                                   |
| `messages`                           | 必填。支持 `system`/`developer`/`user`/`assistant` 消息；`user` 消息可包含 `image_url` 和 `file` 内容块，见[发送文件](#发送文件)。 |
| `stream`                             | 可选 boolean。设为 `true` 时返回 SSE chunks。                      |
| `temperature`、`top_p`、`max_tokens` | 可选。传入时必须是有限数字。                                       |
| `metadata.session_id`                | 可选。用于继续 Manyfold 会话。                                     |
| `stream_options.include_usage`       | 可选。设为 `true` 时，如果有用量数据，流式响应会包含 usage chunk。 |

支持图片和文件内容块（见[发送文件](#发送文件)）。tool calls、function calls，以及 provider-specific raw response format 不属于 v1 公开 API。

## 默认权限模式

通过这个 API 发起的 coding-agent turn 默认使用非受限执行模式：

| Framework   | 默认值                                |
| ----------- | ------------------------------------- |
| Claude Code | `bypassPermissions`                   |
| Codex       | Full access，跳过 approval 和 sandbox |
| Gemini CLI  | `--approval-mode yolo`                |

这些默认值让 API 驱动的 Agent 可以在没有交互式确认弹窗的情况下完成文件修改、终端命令和工作区自动化。OpenAI 兼容 v1 endpoint 不提供逐请求权限模式控制；如果某个 turn 需要更窄的权限模式，请使用 Manyfold Chat UI 或原生 Chat API。

## 错误格式

错误使用 OpenAI 风格：

```json
{
    "error": {
        "message": "API token does not have chat.completions scope",
        "type": "authentication_error",
        "code": "invalid_api_key"
    }
}
```

常见修复方式：

- 使用 `nca_` API token，不要使用浏览器 session token。
- 创建 token 时选择 `chat.completions` 或 `api.full` scope。
- 确认 `model` 是该 token 所属用户拥有的 agent id。
- 发送图片或文档时，使用 `image_url`/`file` 内容块（见[发送文件](#发送文件)）。

## 另请参阅

- [API 参考](/zh/api-reference/)
- [用 API 读取会话](/zh/docs/api-conversations/)
- [通过 A2A 调用 Agent](/zh/docs/api-a2a/)
- [创建第一个 Agent](/zh/docs/create-agent/)
