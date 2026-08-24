---
title: 从 Agent 主动发送
description: 让 Agent 通过已绑定渠道主动发送消息和显式 workspace 文件。
order: 18
---
Agent 可以用 `mf channels send` 主动发起私聊、向群聊发消息，或原生回复某条 provider 消息，无需等待新的 inbound turn。对方的回复仍通过普通 Channel 流程进入 Agent；开启 **Send message context** 时，回复会带有 `[Channel message context]`，因此 Agent 可以关联 sender、chat、message、reply 和 thread ID。

## Provider 支持

| Provider                       | 文本                     | 显式 workspace 文件 |
| ------------------------------ | ------------------------ | ------------------- |
| Lark / 飞书                    | 支持                     | 支持                |
| Telegram                       | 支持                     | 支持                |
| WeChat                         | 支持；仅 DM 目标         | 不支持              |
| Matrix                         | 支持                     | 不支持              |
| Slack、Discord、Linear、GitHub | 不支持 direct agent send | 不支持              |

这项能力与普通 Agent 回复中的文件链接不同。Telegram 不会把 inbound 媒体传给 Agent，普通回复里的文件链接也不会自动上传；但显式使用 `mf channels send --file` 会把 workspace 文件上传到 Telegram。

WeChat 只能向此前已给 bot 发过消息的用户主动发送，因为该 inbound 消息会建立 provider reply credential。

## 前提条件

- Channel 必须处于 `active` 状态并绑定到发送消息的 Agent。可用 `mf channels list --json` 检查。
- Agent runtime identity 不需要额外 scope；human login token 必须拥有该 Channel，并具备 `channels:edit`。
- 每次请求必须且只能指定一个目标：`--chat-id`、`--user-id` 或 `--reply-to`。
- 使用之前 `[Channel message context]` 中的 provider ID：`chat_id`、`sender_id` 或 `message_id`。上一次发送结果中的 `providerMessageId` 也可作为 reply target。

## 发送文本或文件

```sh
mf channels send <channelId> --user-id <provider_user_id> --text "今天完成了什么？"
mf channels send <channelId> --chat-id <provider_chat_id> --text "站会将在 10 分钟后开始。"
mf channels send <channelId> --reply-to <provider_message_id> --text "收到，已记录。"
mf channels send <channelId> --chat-id <provider_chat_id> --text "本周数据" --file reports/weekly.pdf --file out/chart.png
```

`--text` 和 `--file` 可以单独使用，也可以同时使用。`--file` 可重复传入，最多四个路径。每个路径都必须位于发送 Agent 的 workspace 内；请使用 workspace 中显示的相对路径，也可带 `/workspace/` 前缀。

平台会在发送时读取文件，重试时重新读取。文本和文件使用两条独立的 durable delivery，因此文件上传失败只会重试文件，不会重新发送已经成功的文本。

## 理解返回结果

只发文本或只发文件时，顶层字段表示本次 delivery：

```json
{
    "deliveryId": "42",
    "status": "sent",
    "providerMessageId": "om_x"
}
```

同时发送文本和文件时，`files` 单独表示附件 delivery：

```json
{
    "deliveryId": "42",
    "status": "sent",
    "providerMessageId": "om_x",
    "files": {
        "deliveryId": "43",
        "status": "sent",
        "providerMessageId": "om_y"
    }
}
```

`sent` 表示 provider 已接受投递。`queued` 表示首次尝试失败，Manyfold 会按 backoff 重试；不要立即重复发送。如需关联对方回复或之后原生回复该消息，请保留 `providerMessageId`。

## 限制与恢复

- 每个 Agent/Channel 组合每分钟最多 30 次发送请求。遇到 rate-limit error 时等待 `retryAfterSec`，并尽量合并批量触达。
- 如提示必须指定唯一 target，只保留一个目标参数。
- 如 Channel 是 draft 或 paused，请让 owner 先激活。
- 如 provider 不支持 direct text/file send，请改用上表支持的 provider，或移除 `--file`。
- 如文件 delivery 返回 `no readable files`，请检查 workspace 路径并只重发文件；已经成功的文本无需重复。

## 另请参阅

- [连接渠道](/zh/docs/channels/)
- [Lark 和飞书](/zh/docs/channels/lark/)
- [Telegram](/zh/docs/channels/telegram/)
- [WeChat](/zh/docs/channels/weixin/)
- [Matrix](/zh/docs/channels/matrix/)
- [切换会话](/zh/docs/channels/session-switching/)
