import type { Locale } from '@/lib/i18n'

type ApiParam = {
    name: string
    required?: boolean
    description: string
}

type ApiEndpoint = {
    id: string
    method: 'GET' | 'POST'
    path: string
    title: string
    description: string
    auth: string
    quota: string
    params: ApiParam[]
    response: string[]
}

type ApiReferenceCopy = {
    title: string
    description: string
    eyebrow: string
    quickStartTitle: string
    quickStartLead: string
    baseUrlLabel: string
    authLabel: string
    scopeLabel: string
    quickStartSteps: string[]
    endpointsTitle: string
    endpointsLead: string
    requestTitle: string
    responseTitle: string
    authTitle: string
    quotaTitle: string
    paramsTitle: string
    descriptionLabel: string
    requiredLabel: string
    optionalLabel: string
    examplesTitle: string
    chatExampleTitle: string
    streamingTitle: string
    streamingLead: string
    conversationsExampleTitle: string
    messagesExampleTitle: string
    errorsTitle: string
    errorsLead: string
    tokensTitle: string
    tokensLead: string
    guideLinkLabel: string
    conversationsGuideLinkLabel: string
    endpoints: ApiEndpoint[]
    examples: {
        chatRequest: string
        chatResponse: string
        streamRequest: string
        conversationsRequest: string
        messagesRequest: string
        errorResponse: string
    }
}

const en: ApiReferenceCopy = {
    title: 'API Reference',
    description:
        'Fast reference for integrating Manyfold agents with external apps, scripts, and OpenAI-compatible SDKs.',
    eyebrow: 'Developer API',
    quickStartTitle: 'Connect in three minutes',
    quickStartLead:
        'Use the hosted API origin, create a scoped token, then send an OpenAI-compatible request where model is your Manyfold agent id.',
    baseUrlLabel: 'Base URL',
    authLabel: 'Auth',
    scopeLabel: 'Recommended scope',
    quickStartSteps: [
        'Create or choose an agent and copy its agt_ id.',
        'Create an API token in Settings -> API tokens.',
        'Call /chat/completions with Authorization: Bearer $MF_API_TOKEN.'
    ],
    endpointsTitle: 'Endpoints',
    endpointsLead:
        'The public v1 surface is intentionally small: create turns, list API-created conversations, and replay messages.',
    requestTitle: 'Request',
    responseTitle: 'Response',
    authTitle: 'Auth',
    quotaTitle: 'Quota',
    paramsTitle: 'Parameters',
    descriptionLabel: 'Description',
    requiredLabel: 'Required',
    optionalLabel: 'Optional',
    examplesTitle: 'Examples',
    chatExampleTitle: 'Create a non-streaming turn',
    streamingTitle: 'Streaming',
    streamingLead:
        'Set stream to true to receive Server-Sent Events. The x-session-id response header identifies the Manyfold session.',
    conversationsExampleTitle: 'List recent conversations',
    messagesExampleTitle: 'Replay a conversation',
    errorsTitle: 'Errors',
    errorsLead:
        'Errors use an OpenAI-style envelope so compatible clients can handle auth and validation failures consistently.',
    tokensTitle: 'Tokens and scopes',
    tokensLead:
        'Use nca_ API tokens. The chat.completions scope can create chat turns and read the same user-owned API conversations; api.full is for trusted internal clients.',
    guideLinkLabel: 'Full chat guide',
    conversationsGuideLinkLabel: 'Conversation guide',
    endpoints: [
        {
            id: 'chat-completions',
            method: 'POST',
            path: '/api/v1/chat/completions',
            title: 'Create a chat completion',
            description:
                'Start a turn with a Manyfold agent through the OpenAI-compatible Chat Completions shape.',
            auth: 'Bearer API token with chat.completions or api.full.',
            quota: 'Counts against the monthly API request quota.',
            params: [
                {
                    name: 'model',
                    required: true,
                    description: 'Manyfold agent id, for example agt_...'
                },
                {
                    name: 'messages',
                    required: true,
                    description:
                        'system/developer/user/assistant messages. A user message may include image_url and file content parts.'
                },
                {
                    name: 'stream',
                    description: 'Set true for Server-Sent Events.'
                },
                {
                    name: 'metadata.session_id',
                    description:
                        'Continue an existing Manyfold session returned by a previous turn.'
                },
                {
                    name: 'stream_options.include_usage',
                    description:
                        'When true, streaming can include a final usage chunk if usage is available.'
                }
            ],
            response: [
                'Non-streaming responses return chat.completion with choices[0].message.content.',
                'metadata.session_id and x-session-id identify the Manyfold conversation.',
                'Streaming responses emit chat.completion.chunk events followed by data: [DONE].'
            ]
        },
        {
            id: 'conversations',
            method: 'GET',
            path: '/api/v1/conversations',
            title: 'List conversations',
            description:
                'List non-channel conversations created through the OpenAI-compatible v1 API.',
            auth: 'Bearer API token with chat.completions or api.full.',
            quota: 'Read-only endpoint; not counted against monthly API request quota.',
            params: [
                {
                    name: 'model',
                    description:
                        'Filter by agent id. Tokens bound to one agent are limited to that agent.'
                },
                {
                    name: 'limit',
                    description: '1-100 results. Defaults to 20.'
                },
                {
                    name: 'after',
                    description:
                        'Object id from first_id or last_id for cursor pagination.'
                },
                {
                    name: 'order',
                    description: 'desc by default. Use asc for oldest first.'
                }
            ],
            response: [
                'Returns an OpenAI-style list envelope with object, data, first_id, last_id, and has_more.',
                'Each item has id, model, title, created_at, and updated_at.'
            ]
        },
        {
            id: 'conversation-messages',
            method: 'GET',
            path: '/api/v1/conversations/{session_id}/messages',
            title: 'List conversation messages',
            description:
                'Replay messages for one API-created conversation, including text and full Manyfold content blocks.',
            auth: 'Bearer API token with chat.completions or api.full.',
            quota: 'Read-only endpoint; not counted against monthly API request quota.',
            params: [
                {
                    name: 'session_id',
                    required: true,
                    description:
                        'Manyfold session id returned as x-session-id or metadata.session_id.'
                },
                {
                    name: 'limit',
                    description: '1-100 results. Defaults to 20.'
                },
                {
                    name: 'after',
                    description:
                        'Object id from first_id or last_id for cursor pagination.'
                },
                {
                    name: 'order',
                    description:
                        'desc by default. Use asc for chronological replay.'
                }
            ],
            response: [
                'content is an OpenAI-compatible message parts array.',
                'content_blocks preserves Manyfold-specific transcript details such as tool calls.'
            ]
        }
    ],
    examples: {
        chatRequest: `curl https://api.manyfold.ai/api/v1/chat/completions \\
  -H "Authorization: Bearer $MF_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agt_your_agent_id",
    "messages": [
      { "role": "user", "content": "Summarize this repository." }
    ]
  }'`,
        chatResponse: `{
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
}`,
        streamRequest: `curl -N https://api.manyfold.ai/api/v1/chat/completions \\
  -H "Authorization: Bearer $MF_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agt_your_agent_id",
    "stream": true,
    "stream_options": { "include_usage": true },
    "messages": [
      { "role": "user", "content": "Write a short release note." }
    ]
  }'`,
        conversationsRequest: `curl "https://api.manyfold.ai/api/v1/conversations?limit=20" \\
  -H "Authorization: Bearer $MF_API_TOKEN"`,
        messagesRequest: `curl "https://api.manyfold.ai/api/v1/conversations/cts_your_session_id/messages?order=asc" \\
  -H "Authorization: Bearer $MF_API_TOKEN"`,
        errorResponse: `{
    "error": {
        "message": "API token does not have chat.completions scope",
        "type": "authentication_error",
        "code": "invalid_api_key"
    }
}`
    }
}

const zh: ApiReferenceCopy = {
    title: 'API Reference',
    description:
        '面向开发者的 Manyfold API 速查，用于把 Agent 接入外部应用、脚本和 OpenAI 兼容 SDK。',
    eyebrow: 'Developer API',
    quickStartTitle: '三分钟完成接入',
    quickStartLead:
        '使用托管 API origin，创建带 scope 的 token，然后发送 OpenAI 兼容请求；model 字段填写 Manyfold agent id。',
    baseUrlLabel: 'Base URL',
    authLabel: '认证',
    scopeLabel: '推荐 scope',
    quickStartSteps: [
        '创建或选择一个 Agent，并复制它的 agt_ id。',
        '在 Settings -> API tokens 创建 API token。',
        '调用 /chat/completions，并带上 Authorization: Bearer $MF_API_TOKEN。'
    ],
    endpointsTitle: 'Endpoints',
    endpointsLead:
        '公开 v1 API 保持很小：创建 Agent turn，列出 API 创建的会话，并回放消息。',
    requestTitle: '请求',
    responseTitle: '响应',
    authTitle: '认证',
    quotaTitle: '配额',
    paramsTitle: '参数',
    descriptionLabel: '说明',
    requiredLabel: '必填',
    optionalLabel: '可选',
    examplesTitle: '示例',
    chatExampleTitle: '创建非流式 turn',
    streamingTitle: '流式响应',
    streamingLead:
        '设置 stream: true 后会返回 Server-Sent Events。响应里的 x-session-id header 表示 Manyfold session。',
    conversationsExampleTitle: '列出最近会话',
    messagesExampleTitle: '回放一个会话',
    errorsTitle: '错误格式',
    errorsLead:
        '错误使用 OpenAI 风格 envelope，方便兼容客户端统一处理认证和参数校验失败。',
    tokensTitle: 'Token 与 scope',
    tokensLead:
        '使用 nca_ API token。chat.completions scope 可以创建 chat turn，也可以读取同一用户通过 API 创建的会话；api.full 只建议给可信内部客户端使用。',
    guideLinkLabel: '完整 Chat 指南',
    conversationsGuideLinkLabel: 'Conversation 指南',
    endpoints: [
        {
            id: 'chat-completions',
            method: 'POST',
            path: '/api/v1/chat/completions',
            title: '创建 chat completion',
            description:
                '通过 OpenAI 兼容的 Chat Completions 形状向 Manyfold Agent 发起一个 turn。',
            auth: 'Bearer API token，scope 为 chat.completions 或 api.full。',
            quota: '计入每月 API request 配额。',
            params: [
                {
                    name: 'model',
                    required: true,
                    description: 'Manyfold agent id，例如 agt_...'
                },
                {
                    name: 'messages',
                    required: true,
                    description:
                        '支持 system/developer/user/assistant role；user 消息可包含 image_url 和 file 内容块。'
                },
                {
                    name: 'stream',
                    description: '设为 true 时返回 Server-Sent Events。'
                },
                {
                    name: 'metadata.session_id',
                    description: '继续此前 turn 返回的 Manyfold session。'
                },
                {
                    name: 'stream_options.include_usage',
                    description:
                        '设为 true 时，如果有用量数据，流式响应可包含最终 usage chunk。'
                }
            ],
            response: [
                '非流式响应返回 chat.completion，可读取 choices[0].message.content。',
                'metadata.session_id 和 x-session-id 用于识别 Manyfold 会话。',
                '流式响应发送 chat.completion.chunk event，最后是 data: [DONE]。'
            ]
        },
        {
            id: 'conversations',
            method: 'GET',
            path: '/api/v1/conversations',
            title: '列出会话',
            description: '列出通过 OpenAI 兼容 v1 API 创建的非渠道会话。',
            auth: 'Bearer API token，scope 为 chat.completions 或 api.full。',
            quota: '只读接口，不计入每月 API request 配额。',
            params: [
                {
                    name: 'model',
                    description:
                        '按 agent id 过滤。绑定到单个 agent 的 token 只能读取该 agent。'
                },
                {
                    name: 'limit',
                    description: '1-100 条结果，默认 20。'
                },
                {
                    name: 'after',
                    description:
                        '使用上一页的 first_id 或 last_id 做 cursor pagination。'
                },
                {
                    name: 'order',
                    description: '默认 desc；使用 asc 获取最旧优先。'
                }
            ],
            response: [
                '返回 OpenAI 风格 list envelope，包含 object、data、first_id、last_id、has_more。',
                '每个 item 包含 id、model、title、created_at、updated_at。'
            ]
        },
        {
            id: 'conversation-messages',
            method: 'GET',
            path: '/api/v1/conversations/{session_id}/messages',
            title: '列出会话消息',
            description:
                '回放某个 API 会话里的消息，包含文本和完整 Manyfold content blocks。',
            auth: 'Bearer API token，scope 为 chat.completions 或 api.full。',
            quota: '只读接口，不计入每月 API request 配额。',
            params: [
                {
                    name: 'session_id',
                    required: true,
                    description:
                        'x-session-id 或 metadata.session_id 返回的 Manyfold session id。'
                },
                {
                    name: 'limit',
                    description: '1-100 条结果，默认 20。'
                },
                {
                    name: 'after',
                    description:
                        '使用上一页的 first_id 或 last_id 做 cursor pagination。'
                },
                {
                    name: 'order',
                    description: '默认 desc；使用 asc 按时间顺序回放。'
                }
            ],
            response: [
                'content 是 OpenAI 兼容的 message parts 数组。',
                'content_blocks 保留 Manyfold 特有的 transcript 细节，例如 tool call。'
            ]
        }
    ],
    examples: en.examples
}

export type { ApiEndpoint, ApiParam, ApiReferenceCopy }

export const apiReferenceFor = (locale: Locale): ApiReferenceCopy =>
    locale === 'zh' ? zh : en
