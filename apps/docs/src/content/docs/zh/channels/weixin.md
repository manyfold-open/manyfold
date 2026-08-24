---
title: WeChat
description: 通过腾讯 iLink 网关把个人微信 bot 连接到 Manyfold Agent。
order: 15
---
当你希望 Agent 在个人微信里回复私聊消息时，可以连接 WeChat。Manyfold 通过腾讯官方的 iLink bot 网关接入：你用微信扫码授权一个 bot，Manyfold 用得到的 bot token 对网关做长轮询，不需要公开 webhook。

WeChat 只支持**私聊**。扫码授权得到的是一个 bot 身份（`…@im.bot`），它无法被拉进普通微信群，网关也不会投递群消息事件。因此没有群聊、@mention 或 thread 相关配置。

## 渠道能力

| 能力 | 支持情况 |
| ---- | -------- |
| 私聊 | 支持；用户发给 bot 的每条消息都会驱动 Agent。 |
| 群聊 | 不支持；个人微信 bot 无法进群，群事件不会被投递。 |
| 实时进度 | 不支持；微信无法编辑已发送的消息，Agent 会在这一轮结束后一次性回复，处理期间显示“正在输入”。 |
| Slash command | 支持输入文本命令；Manyfold 不管理微信原生命令菜单。 |
| 文件和媒体 | 接收图片和白名单内的文档类型；可发送 Agent 回复中链接的图片和文件。语音在有微信转写文本时使用转写内容；音频和视频以简短占位呈现。 |
| 引用回复 | 支持；被引用的消息会作为一行简短上下文传给 Agent。 |
| Agent 主动发送 | 支持，尽力而为；接收方需先给 bot 发过至少一条消息，才存在回复凭证。 |

## 前置条件

- 一个已有的 Manyfold Agent。
- 一个用于扫码授权的个人微信账号。
- 扫码成功后签发的 iLink bot token。

bot token 绑定的是授权得到的会话，而不是来源 IP，因此你用手机授权后，Manyfold 可以在服务器上持续保持这个连接。若会话之后过期，微信会返回错误码 `-14`，重新扫码即可签发新 token。

## 连接到 Manyfold

1. 打开 **设置 -> 渠道**。
2. 新建渠道，选择 **WeChat**。
3. 选择 Agent 并填写标签。
4. 粘贴 iLink bot token。网关 base URL 留空即使用默认网关。
5. 可选：用 **Allowed user IDs** 限制谁能使用该 bot，用 **Operator user IDs** 限制谁能运行 Agent 级命令。
6. 创建渠道并运行 **Register**。
7. 在微信里给 bot 发消息。
8. 运行 **Test**。

Register 会用网关校验 token 并激活渠道。首次轮询只保存同步游标，不会把最近的历史积压当作新的 Agent 轮次重放；后续轮询才投递新消息。你不需要暴露或复制 Manyfold 的 inbound URL。

## 访问控制

- **Allowed user IDs** 是 iLink 用户 ID 的白名单（例如 `wxid_xxx@im.wechat`）。留空表示任何给 bot 发消息的人都被允许。
- **Operator user IDs** 控制 `/model` 等 Agent 级命令。operator 列表为空时，所有人都被拒绝执行这些命令（fail-closed）。
- 用户第一次给 bot 发消息时，其 iLink ID 会出现在该渠道的投递日志里，可从中复制来构建白名单。

## 消息行为

- 回复会针对微信 bot 渲染器做过滤：代码块、行内代码、表格、加粗会透传；不支持的 markdown（如中文两侧的斜体标记、小号标题、图片语法）会被去掉。
- 长回复会被切分（默认 2000 字符一段）依次发送，段间有短暂停顿。
- 若网关限流发送（错误码 `-2`），渠道会短暂暂停出站发送并重试；当第一段已发出、后续某段仍失败时，会补一条“消息不完整”的提示，而不是重发前面的内容。
- 语音在有微信转写文本时按转写内容投递；音频和视频因不在附件白名单内，以简短占位文本呈现。
- 入站图片和白名单内的文档类型会被下载、解密并作为附件传给 Agent。当 Agent 回复中链接了工作区文件时，图片按图片发送、其他文件按文件消息发送。
- 被引用（回复）的消息会作为一行简短的 `[Replying to: …]` 上下文传给 Agent。
- 处理期间显示“正在输入”指示。

## Agent 主动发送

绑定在已激活 WeChat 渠道上的 Agent 可以用 `mf channels send` 主动发起消息。拥有该渠道且具备 `channels:edit` 的人类 token 也可以用同一命令。

```sh
mf channels send <channelId> --user-id 'wxid_xxx@im.wechat' --text '你的构建已完成。'
```

由于微信回复需要一个 per-recipient 的凭证（网关在用户给 bot 发消息时签发），Agent 主动发送只能触达此前给 bot 发过消息的人。若没有可用凭证，发送会以明确的错误信息失败。Agent 主动发送每个渠道限制为每分钟 30 条。

## 设置项

| 设置 | 建议 |
| ---- | ---- |
| Allowed users | 私有部署时使用白名单。留空表示允许任何给 bot 发消息的人。 |
| Operator users | 填入允许运行 Agent 级命令的 iLink 用户 ID。留空表示对所有人拒绝这些命令。 |
| 上传 Agent 链接的文件 | 保持开启可上传 Agent 最终回复中链接的文件；只需纯文本输出时关闭。 |
| 发送消息上下文 | 保持开启，让 Agent 收到发送者与消息 ID。 |

## 验证

运行 **Test**。健康的结果会确认网关可达、token 被接受、渠道状态为 active。结果还会单独报告是否已存储同步游标；`not stored yet` 不会导致测试失败，但你应等首次轮询完成后再发送验证消息。

## 排查

- **token 被拒或渠道报告会话过期（`-14`）**：iLink 会话已过期。重新扫码，然后更新渠道上的 bot token。
- **渠道一直 connecting 或报告网关错误**：确认 Manyfold 能访问 iLink 网关，且 token 仍然有效。
- **bot 不响应**：确认发送者在 **Allowed user IDs** 中（或将其留空），且渠道状态为 active。
- **Agent 级命令被拒绝**：把发送者的 iLink 用户 ID 加入 **Operator user IDs**。
- **Agent 主动发送失败**：接收方必须此前给 bot 发过至少一条消息，才存在回复凭证。
- **群消息被忽略**：个人微信 bot 只支持私聊，网关不投递群事件。

## 参见

- [连接渠道](/zh/docs/channels/)
- [会话切换](/zh/docs/channels/session-switching/)
- [Telegram](/zh/docs/channels/telegram/)
- [Matrix](/zh/docs/channels/matrix/)
- [从 Agent 主动发送](/zh/docs/channels/agent-send/)
