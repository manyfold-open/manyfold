---
title: Lark 和飞书
description: 将 Lark 或飞书自定义 app 连接到 Manyfold Agent。
order: 12
---
当你希望在 Lark 或飞书工作区的私聊、群聊或团队工作流中访问 Agent 时，可以连接对应平台。请选择创建 app 时所在的开放平台：`open.feishu.cn` 对应飞书，`open.larksuite.com` 对应 Lark。

## 渠道能力

| 能力 | 支持情况 |
| ---- | -------- |
| 私聊、群聊和消息 thread | 支持；群聊默认需要 @mention。 |
| Webhook 和长连接 | 均支持；长连接不需要公开 callback URL。 |
| 文本、富文本、图片和文件 | 支持；语音/视频以占位文本进入，视频封面可用时一并附加。 |
| 原生回复和最近历史上下文 | 支持；群聊回复可引用触发消息，mention 时可回填最近讨论。 |
| Session command 卡片 | 支持；`/list` 等视图可使用交互按钮。 |
| 实时卡片和 CardKit streaming | 支持；默认 Patch，CardKit 提供原生打字机流式。 |
| 用户和 operator allowlist | 支持；dispatch 前检查 Lark/飞书 `open_id`。 |
| Agent 主动发送文本和文件 | 支持；`mf channels send` 接受 chat/user/reply target 和显式 workspace 文件。 |

## 前提条件

- 已有 Manyfold Agent。
- 扫码快捷创建：扫码账号有权批准创建 app。
- 手动配置：有权限在 Lark 或飞书开放平台中创建或管理自定义 app，并已启用 bot 能力。

## 扫码快捷创建（推荐）

扫码快捷创建会让开放平台自动创建并配置 bot，生成的 App Secret 始终只由 Manyfold 服务端处理。

1. 打开 **Settings -> Channels**，创建渠道并选择 **飞书** 或 **Lark**。
2. 选择目标 Agent、app 区域、label 和 bot name。
3. 保持选中 **二维码**，然后生成二维码。
4. 使用有权批准创建 app 的账号扫码，检查请求的权限并批准。扫码账号决定 app 创建在哪个平台：飞书账号创建在 `open.feishu.cn`，Lark 账号创建在 `open.larksuite.com`。
5. 等待 Manyfold 创建 active 长连接/WebSocket channel，然后运行 **Test** 并给 bot 发消息。

扫码人的 app-scoped `open_id` 会自动加入 operator 列表，可执行 `/model` 等 agent 级命令。通过此流程注册的 app 不需要再单独发布版本。在等待扫码时关闭面板会取消该注册；拒绝或过期后可以重新生成二维码。

扫码快捷创建会请求以下 9 个 tenant scopes，以支持本文档中的 Lark/飞书 channel 能力：

| Scope ID | 用途 |
| -------- | ---- |
| `im:message.p2p_msg:readonly` | 接收发给 bot 的私聊消息。 |
| `im:message.group_at_msg:readonly` | 接收群内 @mention bot 的消息。 |
| `im:message:send_as_bot` | 发送 Agent 回复和卡片。 |
| `im:resource` | 下载和上传消息中的图片/文件。 |
| `im:message:readonly` | 读取引用消息和最近上下文。 |
| `im:message.group_msg` | 在需要时接收/读取所有群消息。这是敏感权限；如果 bot 不应使用该权限，请保持 **Mention only** 开启并关闭 history backfill。 |
| `im:message.reactions:write_only` | 添加和移除临时“处理中”状态表情。 |
| `contact:user.base:readonly` | 解析发送者显示名称。 |
| `cardkit:card:write` | 选择 CardKit 时使用打字机流式。 |

注册还会配置事件 `im.message.receive_v1` 和回调 `card.action.trigger`。设备码和 App Secret 由 API 处理，绝不会发送到浏览器或由注册接口返回。

快捷创建固定使用长连接。Lark 国际版租户应在创建后测试连接；如果 WebSocket 无法建立，请把 channel 改为 Webhook，并按下文手动完成事件/回调配置。

连接已有 app、使用 Webhook 或希望只授予更小权限集合时，请切换到 **手动配置**。

## 手动创建 app

1. 打开飞书或 Lark 开放平台控制台。
2. 创建自定义 app。
3. 启用 bot 能力。
4. 复制 App ID 和 App Secret。
5. 修改权限或事件订阅后，发布 app 版本。

### 配置权限

在开放平台控制台进入 **权限管理**，为应用身份添加下列 scope，然后发布新的 app 版本。如果飞书和 Lark 控制台显示的权限名称不同，请直接搜索准确的 scope ID。

以下 3 项是基础权限，建议全部添加：

| 使用场景            | Scope ID                                  | 控制台中的权限名称                  | 缺少时的表现                 |
| ------------------- | ----------------------------------------- | ----------------------------------- | ---------------------------- |
| 私聊                | `im:message.p2p_msg:readonly`             | 读取用户发给机器人的单聊消息        | 私聊消息无法到达 Manyfold。  |
| 群聊中 @机器人      | `im:message.group_at_msg:readonly`        | 获取群组中用户 @机器人的消息        | 群内 @机器人的消息无法到达。 |
| Agent 回复和卡片    | `im:message:send_as_bot`                  | 以应用身份发送消息                  | Agent 能收到消息，但无法回复。 |

下面的权限只在使用对应功能时添加：

| 功能                       | 额外 Scope ID                                  | 何时需要 |
| -------------------------- | ---------------------------------------------- | -------- |
| 接收和发送图片/文件        | `im:resource`                                  | 下载用户附件、上传 Agent 回复中链接的文件时必需。 |
| 接收群内所有消息           | `im:message.group_msg`                         | 关闭 **Mention only** 时必需。这是敏感权限；如果 bot 只需响应 @mention，请保持 Mention only 开启。 |
| 引用回复上下文             | `im:message:readonly`                          | 让 Manyfold 读取被回复的原消息；读取群消息时还需添加 `im:message.group_msg`。 |
| 最近群聊历史               | `im:message:readonly` 和 `im:message.group_msg` | 群内 @机器人时回填最近消息所必需；不希望授予群消息读取权限时，请关闭 history backfill。 |
| “处理中”状态表情           | `im:message.reactions:write_only`              | 让 Manyfold 添加和移除临时处理状态表情；未授权不影响正常对话。 |
| 发送者显示名称             | `contact:user.base:readonly`                   | 显示发送者姓名；未授权时使用原始 `open_id`。 |
| CardKit 打字机流式         | `cardkit:card:write`                           | 仅当 **Streaming updates** 设为 **Cardkit** 时需要；默认 **Patch** 模式不需要。 |

控制台也可能提供范围更大的 `im:message`（获取与发送单聊、群组消息）权限。它可以替代“读取私聊消息”和“以应用身份发送消息”两项基础 scope，但不能替代群内 @mention 所需的 `im:message.group_at_msg:readonly`，也不能替代读取群内全部消息所需的 `im:message.group_msg`。

## 选择连接模式

| 模式 | 适用情况 | 开放平台配置 |
| ---- | -------- | ------------ |
| 长连接 / WebSocket | 允许 outbound connection 时推荐，不需要公开 URL。 | 在事件和回调两处都选择 **使用长连接接收事件**。 |
| Webhook | 部署能通过 HTTPS 暴露 Manyfold inbound URL 时使用。 | 把 inbound URL 填为 Request URL，并配置一致的 Verification Token 或 Encrypt Key。 |

Manyfold 中选择的平台区域和连接模式必须与开放平台控制台一致。

## 事件订阅

订阅消息事件：

| 配置位置 | Event 或 callback       | 何时需要 |
| -------- | ----------------------- | -------- |
| 事件订阅 | `im.message.receive_v1` | 始终需要，用于接收用户消息。 |
| 回调订阅 | `card.action.trigger`   | 仅在使用会话卡片按钮时需要，例如 `/list` 的会话选择器。 |

`card.action.trigger` 是 callback，不是应用权限。请在 **回调订阅** 中配置，不要在 **权限管理** 中搜索。webhook 渠道的事件和回调使用同一个 Request URL；长连接渠道需要在两处都选择长连接。

为了 webhook 安全，请在开放平台控制台和 Manyfold 中都配置 Verification Token 或 Encrypt Key。长连接通过 App ID 和 App Secret 鉴权；除非开放平台配置要求，否则 token/key 在长连接模式下可选。

## 支持的消息类型

文本和富文本（post）消息会以文本形式送达 Agent，包括富文本的标题、链接和 mention。图片和文件会被下载并作为附件进入对话。语音和视频消息以占位文本送达（`[voice message]`、`[video: 文件名]`）；视频封面图可用时会作为附件一并送达。

反方向，当 Agent 在回复中链接 workspace 文件（例如生成的图表）时，文件会被上传并作为原生图片或文件消息发送。可通过渠道设置里的 "Attach files the agent links" 关闭。

Inbound attachment 每条消息最多 10 个文件、单文件 25 MB、总计 100 MB。不支持或超限文件会被跳过，其他文本和有效文件继续处理。

## 从 Agent 主动发送

Agent 可以使用 `mf channels send` 按 Lark/飞书 `open_id` 发起私聊、向已知 chat ID 发消息、回复某条 provider message，并显式附加最多四个 workspace 文件。文本与文件使用独立的 durable delivery，因此附件重试不会重复已成功的文本。命令示例、target ID、返回结果和限制见[从 Agent 主动发送](/zh/docs/channels/agent-send/)。

## 手动连接到 Manyfold

1. 打开 **Settings -> Channels**。
2. 创建新渠道，选择 **飞书** 或 **Lark**，然后切换到 **手动配置**。
3. 选择要接收消息的 Agent。
4. 选择 app 区域，以及与开放平台一致的 subscription mode。
5. 输入标签、App ID、App Secret 和 bot 的准确显示名称。Webhook 模式还必须填写 Verification Token 或 Encrypt Key。
6. 创建渠道。
7. 仅 webhook 模式：从渠道详情页复制 inbound URL，并把事件和回调的 Request URL 都设为该地址。
8. 长连接模式：在开放平台事件和回调订阅中都选择长连接，不要配置 inbound URL。
9. 修改权限、事件或回调后发布 app 版本。
10. 运行 **Test**。

## Thread 和命令

- 私聊按 sender 保存 session。群聊默认按 sender 隔离；开启 **Share session in channel** 后全群共享。
- 开启 **Thread isolation** 后，每个消息 thread/root 使用独立 session，回复保持在线程中。
- 群聊答案会尽量原生回复触发消息。
- 已识别命令不受 mention gate 限制。`/list` 和 session detail 使用交互卡片；按钮需要订阅 `card.action.trigger`。
- `/new`、`/list`、`/switch`、`/stop`、`/model`、`/usage` 等命令见[切换 Session](/zh/docs/channels/session-switching/)。

## 推荐设置

| 设置            | 建议                                             |
| --------------- | ------------------------------------------------ |
| Mention only    | 群聊中建议开启，让 Agent 只在被 mention 时回复。 |
| Bot name        | 输入准确的 bot 显示名称；开启 Mention only 时 Manyfold 要求填写。 |
| Shared session  | 默认关闭，除非群里的所有人都应该共享同一段对话。 |
| Thread isolation | 希望消息 thread 使用独立 Agent session 时开启。 |
| Progress mode   | **Preview** 更新一张卡片；**Activity** 还会显示工具/思考活动；**Final** 只发送最终答案。 |
| Reply rendering | 保持 auto：包含 markdown（代码、表格、标题）的回复会以 interactive card 发送以正确渲染。注意卡片消息的推送通知只显示通用预览；如果更在意原生预览可选 text。 |
| Streaming updates | Patch（默认）每次更新整卡替换。Cardkit 启用原生打字机流式和正常的通知摘要，但需要 cardkit 权限；失败会自动回退 Patch。 |
| Attach files the agent links | 希望用户收到生成的 workspace 文件（原生图片/文件）时保持开启。 |
| Backfill chat history | 群 mention 需要最近讨论上下文时保持开启；需要上文列出的 history scope。 |
| Send message context | 建议开启，让 Agent 获得 sender、chat、thread 和 message ID。 |

## 访问控制

两组可选的 Lark 用户 `open_id` 列表控制谁能使用该渠道：

- **Allowed user IDs**：非空时只有列出的用户能驱动 Agent；其他人会被静默忽略（记录在投递日志中）。留空表示任何能触达 bot 的人都可以对话。
- **Operator user IDs**：允许执行 `/model` 等 agent 级命令的用户。未配置 operator 时，这些命令在飞书/Lark 中完全禁用。

用户的 `open_id` 可在开放平台控制台或投递记录的 `sender_id` 中找到。注意 `open_id` 是 app 级的：重建 app 会改变所有用户的 id。

## 验证

打开渠道详情页并运行 **Test**。健康结果会确认凭证和 bot 身份，再检查 WebSocket 状态或 webhook URL 验证。请按实际工作流测试私聊、群内 @mention、`/help` 和小型附件。

## 排查问题

- **Webhook 验证失败**：确认 Verification Token 或 Encrypt Key，并粘贴 Manyfold 当前显示的 inbound URL。
- **长连接无法建立**：确认 Manyfold 和开放平台两边都选择长连接、app 区域正确，并检查平台是否限制同一 app 只有一个活跃 consumer。
- **消息不到达**：确认已订阅 `im.message.receive_v1`，并且 app 版本已发布。
- **群消息被忽略**：设置 bot 显示名称、mention bot，或关闭 mention-only 模式。mention-only 群里未 mention 的图片或文件消息同样会被跳过。
- **图片或文件没有到达 Agent**：批准消息资源下载权限（`im:resource`），并发布 app 版本。
- **Session 卡片按钮超时**：在回调订阅中添加 `card.action.trigger`，并使用与事件投递相同的 webhook URL 或长连接模式。
- **历史、姓名、reaction 或 CardKit 静默降级**：批准该功能对应的可选 scope；缺少它不会阻断普通文本对话。
- **Bot 身份检查失败**：确认 App ID、App Secret、所选平台和已批准的消息权限。

## 另请参阅

- [连接渠道](/zh/docs/channels/)
- [切换 Session](/zh/docs/channels/session-switching/)
- [Telegram](/zh/docs/channels/telegram/)
- [Slack](/zh/docs/channels/slack/)
- [Discord](/zh/docs/channels/discord/)
- [Matrix](/zh/docs/channels/matrix/)
- [从 Agent 主动发送](/zh/docs/channels/agent-send/)
- [飞书开放平台](https://open.feishu.cn/)
- [Lark Open Platform](https://open.larksuite.com/)
- [飞书 API 权限列表](https://open.feishu.cn/document/server-docs/application-scope/scope-list)
- [飞书接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
