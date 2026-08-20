---
title: Matrix
description: 将 Matrix bot 账号连接到 Manyfold Agent。
order: 14
---

# Matrix

当你希望在 Matrix 私聊、房间或 thread 中使用 Agent 时，可以连接 Matrix，既支持公共 homeserver，也支持自托管 homeserver。Manyfold 使用 bot 账号的 Client-Server API access token 和持续运行的 `/sync` 连接，不需要公开 webhook。

## 渠道能力

| 能力 | 支持情况 |
| ---- | -------- |
| 私聊和房间 | 支持；私聊直接响应，房间默认需要 @mention。 |
| Matrix thread | 支持；可隔离已有 thread，也可自动从群消息创建 thread。 |
| 实时进度 | 支持；Agent 工作时持续编辑同一条 Matrix 消息。 |
| Slash command | 支持输入文本命令；Manyfold 不会管理 Matrix 原生命令菜单。 |
| 文件和媒体 | 在未加密 room 中收发图片、文件、音频和视频。 |
| Agent 主动发送 | 支持；可向 room 或 user 发送，也可回复该渠道记录的 provider event。 |
| 端到端加密 | 不支持；REST provider 会把加密 event 记录为 dropped。参见 [ADR-0012](https://github.com/protagolabs/manyfold/blob/develop/docs/decisions/0012-matrix-e2ee-stays-out-of-scope-for-the-rest-provider.md)。 |

## 前提条件

- 已有 Manyfold Agent。
- 一个专用 Matrix bot 账号。
- bot 账号的 homeserver URL 和 access token。
- 未加密的私聊或房间。

请使用 homeserver 的正常注册流程或管理员流程创建 bot 账号，并通过可信的 Matrix client 登录或 homeserver 管理流程获取 access token。不要把 bot 密码或 token 发送到房间消息中。

## 连接到 Manyfold

1. 打开 **Settings -> Channels**。
2. 创建渠道并选择 **Matrix**。
3. 选择 Agent 并输入标签。
4. 输入 homeserver 基础 URL，例如 `https://matrix.example.org`。
5. 粘贴 bot 账号 access token。
6. 配置 room/user 访问、operator ID、mention/session 行为，以及可选的媒体/历史行为。
7. 创建渠道并运行 **Register**。
8. 把 bot 账号邀请到未加密的私聊或房间。
9. 运行 **Test**。

注册会调用 Matrix `whoami`，保存 bot user ID 和显示名称，并启动 `/sync` loop。第一次 sync 会保存 cursor，但不会把其中的 timeline 作为新 Agent turn 回放；后续 sync 才投递新消息。不需要暴露或复制 Manyfold inbound URL。

## 房间、私聊和 mention

- Matrix 私聊根据 bot 账号的 `m.direct` account data 识别。如果一对一房间被当成群聊，请在 client 中把它正确标记为 direct chat。Agent 主动向 user 发送时可以创建 trusted private room，并 best-effort 写入 `m.direct`。
- 私聊始终视为发给 bot。
- 群组房间默认需要 @mention；加入 **Free-response room IDs** 或关闭 **Mention only** 后无需 mention。
- **Allowed room IDs** 和 **Allowed user IDs** 是两组独立 allowlist。留空表示不限制；消息必须通过每个适用的列表。Operator 会自动成为 allowed sender，但不能绕过 room allowlist。
- 开启 **Auto-join invites** 后，bot 只会自动加入符合 allowed-room 规则的邀请。Allowed users 非空时，邀请人必须明确列在其中；只有 operator 身份不能放行邀请。
- **Operator user IDs** 控制 `/model` 等 Agent 级命令；列表为空时所有人都不能执行这些命令。

Matrix ID 必须使用完整形式，例如 `!room:example.org` 和 `@alice:example.org`。

## Thread 和 session

- 开启 **Thread isolation** 后，已有 Matrix thread 使用独立 Agent session。
- 开启 **Auto-thread group replies** 后，未在线程中的房间消息会成为新 Matrix thread 的根消息，Agent 在 thread 内回复。
- 开启 thread isolation 后，不在原生 thread 中的 Matrix reply 会按它直接引用的 event 隔离；出站回复保留原生 reply relation。
- 未启用 thread isolation 时，群聊默认按用户隔离；开启 **Share session in channel** 后全房间共享。
- `/new`、`/list`、`/stop`、`/history` 等文本命令不受 mention gate 限制。详见[切换 Session](../session-switching/)。

## 消息行为

- 处理未加密的 `m.text` event。为避免 bot loop，`m.notice` 默认忽略；只有确实需要 notice 驱动 Agent 时，才通过 channel API 设置 `processNotices: true`。
- 图片、文件、音频和视频通过配置的 homeserver 下载，并遵守通用 channel attachment 限制。在 mention-only room 中，媒体 caption 必须 mention bot；无 caption 媒体只会在 DM、free-response room 或关闭 mention-only 的 room 中进入 Agent。
- Reaction、sticker、文本编辑（`m.replace`）和加密 event 不会启动 Agent turn。
- 回复会 best-effort 读取被引用 event 摘要；发送者显示名和最近 room/thread 历史也会 best-effort 解析，失败时回退但不阻断消息。
- 长回答先按 3,900 字符拆分，再把每个 chunk 渲染为 Matrix HTML。Preview 模式会编辑最初的 `thinking...` event，失败时回退为新消息；回复保留 Matrix 原生 reply/thread relation，Agent turn 运行时 bot 会持续刷新 typing indicator。
- 开启 **Attach files the agent links** 后，Agent 最终回答引用的文件会在文本回复后作为 image/file/audio/video 消息上传；上传失败不会移除已经发送的文本回复。

## Agent 主动发送

绑定到 active Matrix channel 的 Agent 可以用 `mf channels send` 主动联系用户。拥有该 channel 且具备 `channels:edit` 的 human token 也可使用同一命令。

每次必须且只能传入一个 target：

```sh
mf channels send <channelId> --chat-id '!room:example.org' --text 'Standup starts in 10 minutes.'
mf channels send <channelId> --user-id '@alice:example.org' --text 'What did you ship today?'
mf channels send <channelId> --reply-to '$event:example.org' --text 'Thanks, recorded.'
```

- `--chat-id` 向完整 Matrix room ID 发送。
- `--user-id` 只复用 bot 仍处于 joined 状态的 `m.direct` room；否则创建 trusted private room 并邀请该用户。
- `--reply-to` 接受同一 channel 已记录的 inbound Matrix event ID，或之前 `--chat-id` 发送返回的 event ID。目标属于原生 thread 时，回复保留在 thread 内；event 查询失败时，Manyfold 会在已记录 room 中回退为普通 reply。

API 会先记录 durable outbound delivery，再发送消息，并返回 delivery ID、status 和 Matrix event ID。首次发送失败时可能保留 queued 状态等待重试。Agent 主动发送限每个 channel 每分钟 30 次。

## 设置

| 设置 | 建议 |
| ---- | ---- |
| Allowed rooms | bot 加入无关房间时使用 room allowlist；留空允许所有已加入房间。 |
| Allowed users | 私有部署可使用 user allowlist；留空允许 allowed room 中的所有发送者。 |
| Operator users | 填入可执行 Agent 级命令的 Matrix user ID；留空时所有人都不能执行这些命令。 |
| Free-response rooms | 只加入允许每条文本消息直接驱动 Agent、无需 @mention 的房间。 |
| Auto-join invites | 希望 bot 自动接受允许房间的邀请时保持开启。 |
| `processNotices`（API） | 保持默认 `false`；只有 `m.notice` 应明确驱动 Agent 时才开启。 |
| Mention only | 普通群组房间建议开启；free-response room 会覆盖它。 |
| Shared session | 默认关闭以按用户隔离；只有希望全房间共享对话时才开启。 |
| Thread isolation | 希望 Matrix thread 对话互相独立时保持开启。 |
| Auto-thread group replies | 希望未在线程中的群消息自动进入新 thread 时保持开启。 |
| Attach files the agent links | Agent 最终回答引用文件时保持开启；只需要文本输出时关闭。 |
| Backfill room history on mention | 响应 group mention 时补充最近 room/thread 消息作为背景；读取上限会限制在 1–100 个 event。 |
| Progress mode | **Preview** 编辑一条实时消息；**Activity** 还会显示工具/思考活动；**Final** 只发送最终答案。 |
| Send message context | 建议开启，让 Agent 获得 sender、room、thread 和 event ID。 |
| `resetOnIdleMins`（API） | 设置静默多少分钟后自动开启新 session；留空或设为 `0` 表示关闭。 |

## 验证

运行 **Test**。健康结果会确认 `whoami` 和 channel status 为 active；结果会另外报告 sync token 是否已保存。`not stored yet` 不会让测试失败，但表示应等待第一次 sync 完成后再发送验证消息。初始 timeline event 不会作为新 turn 回放，不过后续 history backfill 仍可能把最近 room/thread 消息作为背景。

## 排查问题

- **`whoami` 失败**：检查 homeserver 基础 URL、token 以及 token 是否已被撤销。
- **渠道一直 connecting 或出现 sync error**：确认 Manyfold 能访问 homeserver，且 homeserver 支持 Client-Server `/sync` API。
- **Bot 不加入邀请**：开启 auto-join 并检查 Allowed room IDs。Allowed users 非空时，邀请人必须在该列表中；Operator users 不会覆盖邀请策略。
- **Bot 在房间中不响应**：@mention 它的 user ID/显示名，把房间加入 Free-response rooms，或关闭 Mention only。
- **消息被忽略**：同时检查 room 和 user allowlist，并使用完整 Matrix ID。Operator 只会绕过 user list；每条消息仍必须通过 room list。
- **私聊被当成群聊**：确认 client 已把房间写入 bot 账号的 `m.direct` data。
- **加密消息被忽略**：REST provider 仅支持 plaintext，会把加密 event 记录为 dropped；请使用未加密 room。
- **附件被跳过**：确认它是 `mxc://` image/file/audio/video event、满足单文件 25 MB 和单消息总计 100 MB 的限制，并在 mention-only room 中通过 caption mention bot。
- **Notice 不触发 Agent**：`m.notice` 默认关闭；只有确实需要时才通过 channel API 设置 `processNotices: true`。
- **Agent 级命令被拒绝**：把 sender 的完整 Matrix user ID 加入 Operator users。
- **回复创建了意外 thread**：检查 Auto-thread group replies 和 Thread isolation。
- **Agent 主动发送失败**：确认 channel 为 active、只传一个 target、使用完整 Matrix ID，并确保 reply event ID 之前已被该 channel 记录。
- **发送因限流而延迟**：provider 会遵守 homeserver 的 `retry_after_ms`，并使用同一 transaction 最多重试 3 次，之后才失败。

## 另请参阅

- [连接渠道](../)
- [切换 Session](../session-switching/)
- [Telegram](../telegram/)
- [Slack](../slack/)
- [Lark 和飞书](../lark/)
- [Discord](../discord/)
- [从 Agent 主动发送](../agent-send/)
- [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)
