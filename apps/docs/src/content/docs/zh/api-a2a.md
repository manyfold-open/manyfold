---
title: 通过 A2A 调用 Agent
description: 让外部 client 或 SDK 通过 A2A 协议调用 Manyfold 上的 Agent。
order: 6
---

# 通过 A2A 调用 Agent

Manyfold 可以把一个 Agent 暴露成 [A2A](https://a2a-protocol.org/) server，这样任何 A2A client（官方 SDK、其它 Agent 平台，或者直接 `curl`）都能给它派活并取回结果。

调用方说 A2A 协议时用这条路。只要一个 HTTP 聊天端点的话，用 [OpenAI 兼容 Chat API](../api-chat/) 更简单。

## 1. 暴露 Agent

打开 Agent，进 **A2A** tab，打开暴露开关。没打开之前所有 A2A 请求都返回 `404`——未暴露的 Agent 和不存在的 Agent 对外没有区别。

也可以从 CLI 完成同样的操作。Agent runtime 永远只能管理自己；使用
`mf login` 或 personal API token 时，通过全局 `--agent-id`（或
`MF_AGENT_ID`）选择你拥有的 Agent：

```bash
mf --agent-id {agentId} a2a exposure enable
mf --agent-id {agentId} a2a exposure get
```

tab 上会给出该 Agent 的两个公开 URL：

```text
GET  /api/a2a/agents/{agentId}/agent-card.json
POST /api/a2a/agents/{agentId}/rpc
```

## 2. 给你的 client 铸一个 token

还是 **A2A** tab：**Add caller → External client**。填个名字（比如 `zapier-integration`），可选填过期天数，然后把 token 复制走——它只显示一次。

也可以用 CLI 创建：

```bash
mf --agent-id {agentId} a2a callers add \
  --external \
  --name zapier-integration \
  --expires-in-days 30
```

human mode 下 stdout 只有这一行一次性 bearer，方便直接写进 secret
store；警告和 endpoint 信息写到 stderr。`--json` 会返回包括一次性 token
在内的完整结果。CLI 不保存 token，也无法再次显示。

新增 caller **不会**自动打开 exposure。两步是有意独立的；只有准备好让
公共 A2A server 可访问时，才运行 `mf a2a exposure enable`。

关于这个 token：

- 它**只能调这一个 Agent**。拿去调你名下另一个 Agent 会返回 `403`。
- 它是 Bearer token：请求头带 `Authorization: Bearer <token>`。
- 在 callers 列表里 revoke，下一次调用立即失效。
- **Settings → API tokens** 里铸的个人 token 在这里用不了，即使勾了 `a2a:edit` scope。只有 **External client** 铸出来的 token 有效。

用 `mf a2a callers list` 查看 peer 和 External client grant，用
`mf a2a callers revoke <tokenId> --yes` 撤销。读取 callers/exposure
需要 `a2a:read`；enable、disable、add、revoke 需要 `a2a:edit`。

## 3. 免复制粘贴接入应用

第三方应用可以走 device-code Connect flow，让已登录用户选择一个或多个 Agent。应用不需要获得用户的 Manyfold session 或 personal API token。

先免鉴权创建一个 15 分钟有效的连接会话：

```bash
curl -X POST https://api.manyfold.ai/api/connect/a2a/start \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Team Agents",
    "clientUrl": "https://team-agents.example.com"
  }'
```

`clientName` 必填（最多 60 字符）；`clientUrl` 可选（最多 200 字符）且必须使用 HTTPS。两者都由调用方自报，授权页会明确标成**未经验证**。

```json
{
  "requestId": "acs_…",
  "userCode": "UQMU-2H6P",
  "authUrl": "https://manyfold.ai/connect/a2a?request=acs_…&code=UQMU-2H6P",
  "deviceCode": "mf_cnx_…",
  "expiresAt": "2026-08-05T12:15:00.000Z"
}
```

应用界面展示 `userCode` 并打开 `authUrl`。用户登录 Manyfold、核对 user code、选择最多 20 个 Agent，并决定是否开启 A2A exposure。`deviceCode` 必须按 secret 保存：明文只在 `start` 响应出现，Manyfold 数据库只保存它的 hash。

应用每两秒轮询一次：

```bash
curl -X POST https://api.manyfold.ai/api/connect/a2a/poll \
  -H "Content-Type: application/json" \
  -d '{ "deviceCode": "mf_cnx_…" }'
```

用户尚未决定时返回 `{ "status": "pending" }`；拒绝或超时返回 `denied` 或 `expired`。批准后的第一次 poll 只返回一次凭据：

```json
{
  "status": "approved",
  "userEmail": "owner@example.com",
  "agents": [
    {
      "agentId": "agt_…",
      "name": "release-agent",
      "rpcUrl": "https://api.manyfold.ai/api/a2a/agents/agt_…/rpc",
      "cardUrl": "https://api.manyfold.ai/api/a2a/agents/agt_…/agent-card.json",
      "token": "nca_…",
      "expiresAt": null
    }
  ]
}
```

立即保存每个 token。每个 Agent 都有一枚独立、只允许调用该 Agent 的 External client token；重复 poll 或并发 poll 的输家返回 `expired`，凭据不会再次出现。赢家 poll 发生前不会铸任何 token。RPC 返回 `403` 表示该 Agent 的 grant 已撤销或过期，应提示用户重新连接。

完整 endpoint 契约：

| Endpoint | 鉴权 | 用途 |
| --- | --- | --- |
| `POST /api/connect/a2a/start` | 无 | 以 `{clientName, clientUrl?}` 创建会话；按来源 IP 限流。 |
| `GET /api/connect/a2a/session/{requestId}/{userCode}` | 无 | 给授权页读取未经验证的 client metadata 与状态；按来源 IP 限流。 |
| `POST /api/connect/a2a/approve` | 仅 human session | 批准 `{requestId, userCode, agentIds, enableExposure?, expiresInDays?}`；只记录 consent，不返回 token。 |
| `POST /api/connect/a2a/deny` | 仅 human session | 拒绝 `{requestId, userCode}`。 |
| `POST /api/connect/a2a/poll` | Device code | 单次消费批准结果并返回各 Agent 的凭据；按来源 IP 限流。 |

Connect device code 不是 Manyfold API bearer，也不能拿到 CLI login flow 里兑换。用户从每个 Agent 的 A2A callers 列表撤销最终生成的 token；当前还没有应用级一键断开端点。

## 4. 取 Agent Card

Card 是公开的，不需要 token，里面有协议版本、传输方式和 skill：

```bash
curl https://api.manyfold.ai/api/a2a/agents/{agentId}/agent-card.json
```

同一份 card 也挂在 Agent 路径下的 `/.well-known/agent-card.json`，所以那些从 base URL 解析 card 的 SDK 不需要你手工给出完整 card URL：

```python
from a2a.client import A2ACardResolver

resolver = A2ACardResolver(
    httpx_client,
    base_url="https://api.manyfold.ai/api/a2a/agents/{agentId}",
)
card = await resolver.get_agent_card()
```

## 5. 发消息

`message/send` 跑完一轮并返回完成的 task：

```bash
curl -X POST https://api.manyfold.ai/api/a2a/agents/{agentId}/rpc \
  -H "Authorization: Bearer $MF_A2A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "role": "user",
        "parts": [{ "kind": "text", "text": "总结一下今天还开着的 PR。" }],
        "messageId": "11111111-2222-3333-4444-555555555555"
      }
    }
  }'
```

返回是包着 A2A task 的 JSON-RPC envelope：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "kind": "task",
    "id": "aat_…",
    "contextId": "aac_…",
    "status": { "state": "completed", "timestamp": "2026-07-26T20:39:45.757Z" },
    "artifacts": [{ "artifactId": "artifact-1", "parts": [{ "kind": "text", "text": "…" }] }]
  }
}
```

`message.kind`、`message.role`、`message.parts`、`message.messageId` 都是必填，缺了会返回 JSON-RPC 错误 `-32602`。重复用同一个 `messageId` 会拿回原来那个 task，而不是再跑一轮——所以重试是安全的。

### 接着上一轮聊

把上一个 task 的 `contextId` 带上就复用同一个会话：

```json
"message": {
  "kind": "message",
  "role": "user",
  "contextId": "aac_…",
  "parts": [{ "kind": "text", "text": "再按作者分个组。" }],
  "messageId": "66666666-7777-8888-9999-000000000000"
}
```

只有**你这个 token** 创建的 task 能这样引用。

### 长任务

一轮可能跑很久时有两种做法：

- **流式**——`message/stream` 返回 Server-Sent Events（先 `status-update`，然后是 `artifact-update` 分片）。
- **提交后轮询**——`message/send` 带上 `"configuration": { "blocking": false }`，立刻拿到 `working` 状态的 task，之后用 task id 轮询 `tasks/get`。

## 支持的方法

| 方法 | 用途 |
| --- | --- |
| `message/send` | 跑一轮（阻塞，或 `blocking:false` 提交后轮询） |
| `message/stream` | 跑一轮并用 SSE 推送事件 |
| `tasks/get` | 按 id 取单个 task |
| `tasks/list` | 列出该 token 在这个 Agent 上的 task |
| `tasks/cancel` | 取消尚未结束的 task |
| `tasks/resubscribe` | 重新挂回某个 task 的事件流 |

## 错误

传输与授权问题以 HTTP 状态码 + `{"error": "..."}` 返回；调用本身的问题以 HTTP `200` + JSON-RPC `error` 对象返回。

| 状态码 | 含义 |
| --- | --- |
| `401` | token 缺失、已 revoke 或已过期 |
| `403` | 该 token 不是这个 Agent 的 External client token |
| `404` | Agent 不存在，或没打开 A2A 暴露 |
| `429` | 触发限流——等窗口过去再重试 |
| `200` + `error` | 参数错误、方法未知，或 task 不存在 |

A2A 调用和账号其它调用共用同一份 API 配额。
