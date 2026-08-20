---
title: 连接渠道
description: 将 Agent 连接到受支持的聊天与工作跟踪渠道。
order: 7
---

# 连接渠道

Channel 让用户可以在日常使用的聊天工具中调用 Manyfold Agent。一个渠道把一个外部 bot/app 账号连接到一个 Manyfold Agent，同时保留各平台的私聊、群聊、房间和 thread 行为。

建议先在 Manyfold Web workspace 中确认 Agent 行为符合预期，再根据对话形式、文件、访问控制和托管方式选择渠道。

## 能力概览

| 渠道                  | 投递方式                     | 对话范围                                       | 文件           | 特色能力                                                                                                                            |
| --------------------- | ---------------------------- | ---------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [Telegram](telegram/) | 带 secret 校验的托管 webhook | 私聊、群组、超级群组、论坛话题/回复            | Inbound 仅文本/caption；支持显式 Agent 文件发送 | 自动注册 webhook、best-effort 注册原生命令菜单；无 sender/operator allowlist。                                      |
| [Slack](slack/)       | 签名 webhook                 | DM、MPIM、channel、thread、Assistant/DM thread | 收发文件       | 生成 app manifest、原生 ephemeral slash command、用户/operator policy、auto-thread。                                                |
| [Lark 和飞书](lark/)  | Webhook 或长连接             | 私聊、群聊、消息 thread                        | 收发文件       | 富文本/卡片渲染、CardKit streaming、历史回填、session 卡片按钮、用户/operator policy。                                              |
| [Discord](discord/)   | Gateway 连接                 | DM、server channel、thread                     | 收发文件       | 原生命令/回复、auto-thread、历史回填、可选 usage footer 和 fresh-final 通知。                                                       |
| [Matrix](matrix/)     | Client `/sync`               | 私聊、房间、thread                             | 收发文件       | 自托管 homeserver、actor/operator policy、原生回复、历史回填、Agent 主动发送和媒体；不支持 E2EE。                                   |
| [WeChat](weixin/)     | iLink 长轮询                 | 仅个人私聊                                     | 收发文件       | 扫码授权个人 bot、sender/operator policy、typing 状态、引用上下文，以及向已给 bot 发过消息的用户主动发送。                            |
| [Linear](linear/)     | 签名 webhook                 | 每个 agent session 一个会话，挂在 issue 上     | 不支持         | Agent 作为工作区成员，可被 mention 或委派 issue；思考过程、工具调用与任务清单展示在 session 上；支持 stop request、用户 allowlist。 |
| [GitHub](github/)     | 签名 webhook                 | 每个 issue / PR 一个会话                       | 不支持         | 通过 manifest 流程自动创建专属 GitHub App；在 issue/PR 上 mention 或用标签委派；实时编辑的进展评论；表情回执；association 把关与 login 允许列表。 |

## 通用配置流程

1. 在外部服务中创建专用 bot 或 app 账号。
2. 只授予对应渠道文档列出的必要权限。
3. 打开 Manyfold **Settings -> Channels**。
4. 创建渠道、选择 Agent 并输入凭证。
5. 按需配置外部 event/webhook。Discord、Matrix 和 Lark/飞书长连接不需要 inbound URL。
6. 如有 **Register** 先运行注册，然后运行 **Test**。
7. 按工作流测试私聊、群 mention、thread、命令和文件。

## 通用对话设置

不同 provider 显示的字段略有差异，但共享以下行为：

| 设置                     | 效果                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Mention only             | 在群聊/房间中忽略普通聊天，只在消息明确指向 bot 时响应。DM 不受影响，除非 provider allowlist 阻止。 |
| Share session in channel | 群内所有人共享一个 Agent session。关闭时默认按用户隔离，thread 还可形成更小 scope。                 |
| Thread isolation         | 每个 provider thread/topic 使用独立 Agent session，并把回复留在其中。                               |
| Progress: Preview        | Agent 工作时更新同一条实时消息/卡片。                                                               |
| Progress: Activity       | 显示实时答案，以及 runtime 支持的 tool/thinking 活动。                                              |
| Progress: Final          | 不创建实时 preview，只发送最终答案。                                                                |
| Send message context     | 添加可信的 provider、sender、chat/room、thread 和 message ID，让 Agent 知道消息来源。               |

Provider 文档还会说明 Slack/Lark/Matrix actor policy、Discord/Lark/Matrix 历史回填、文件输出和自动 thread 等专属设置。

## Session 和命令

Scope 决定对话状态所在位置：一个 DM、群内某个用户、共享群聊或 provider thread。每个 scope 可以保存多个命名 session，并记住当前 active session。

所有渠道都理解 `/new`、`/list`、`/switch`、`/current`、`/rename`、`/delete`、`/stop`、`/model`、`/usage`、`/history` 和 `/help`。Telegram、Slack 和 Discord 还提供原生命令入口；Lark/飞书可渲染交互式 session 卡片。详见[切换会话](session-switching/)。

## Agent 主动发送

Agent 可以使用 `mf channels send` 主动向绑定到自身且处于 active 状态的 Channel 发送消息。Lark/飞书、Telegram、WeChat 和 Matrix 支持 direct text send；Lark/飞书与 Telegram 还支持显式 workspace 文件。每次发送只选择一个 provider chat、user 或 message reply target，并使用 durable delivery/retry 路径。命令、target ID、文件语义、返回结果和频率限制见[从 Agent 主动发送](agent-send/)。

## Automation 结果投递

Automation 可以把每次 run 的结果发送到渠道的既有对话中。在 automation 的 **Deliver results** 面板里，先选一个绑定到同一 Agent 的渠道，再选具体投递目标——bot 已经参与过的频道、thread 或 DM。thread 目标会发进 thread 本身，不会落到父频道。如果列表为空，先在该渠道给 bot 发一条消息；在 **Settings -> Channels** 里重命名对话可以让它在选择器中显示友好名称。

对话目标适用于所有 provider，包括 Slack 和 Discord。Telegram、Lark/飞书、WeChat 和 Matrix 还额外支持手填 chat id 或 user id。Agent 回复 `[SILENT]` 时跳过该次 run 的通知。

## 文件和消息限制

Slack、Lark/飞书、Discord、Matrix 和 WeChat 可以把受支持的 attachment 交给支持文件输入的 Agent。Manyfold 每条 inbound message 最多接收 10 个文件、单文件 25 MB、总计 100 MB。错误 attachment 会被跳过，不会丢弃有效文本或其他文件；WeChat 还会按 provider allowlist 限制文档类型。

Telegram 目前只传递 inbound 文本/caption，但 Agent 可以通过 `mf channels send --file` 显式上传 workspace 文件。Matrix 媒体仅适用于未加密 room，且 `m.notice` input 默认关闭。设计文件工作流前请查看对应 provider 文档。

## 安全检查清单

- 每个 Agent 或团队工作流使用专用 bot/app。
- Bot token、app secret、signing secret 和 access token 只填写到渠道凭证中。
- 优先开启 mention gating，并只授予满足工作流的最小 provider 权限。
- 在可用时配置 provider user/room/server allowlist。
- Slack、Lark/飞书和 Matrix 应为 Agent 级命令配置 operator ID；operator 列表为空时会禁用 `/model` 等命令。
- Telegram 没有 sender 或 operator list；任何能联系 bot 的人都能运行已识别命令，包括 Agent 级命令，因此必须限制 bot 和群组访问。
- 加入大群前先在私有对话中测试。
- 通过 delivery log 检查 dropped/failed event，并暂停或删除不再使用的渠道。

## 渠道指南

- [Telegram](telegram/)
- [Slack](slack/)
- [Lark 和飞书](lark/)
- [Discord](discord/)
- [Matrix](matrix/)
- [WeChat](weixin/)
- [Linear](linear/)
- [GitHub](github/)
- [从 Agent 主动发送](agent-send/)
- [切换会话](session-switching/)
