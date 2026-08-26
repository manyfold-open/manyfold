---
title: 切换会话
description: 在同一个渠道里并行运行多个会话，通过 slash 命令在它们之间切换。
order: 16
---
一个聊天或私信可以同时承载多个对话。每个对话是一个独立的 **会话**——拥有自己的历史和模型上下文。会话切换让你可以把一个聊天保留为临时排错线程，另一个用作长期功能开发，在它们之间来回切换而互不干扰。

所有渠道（Telegram、Slack、Lark、飞书、Discord、Matrix）使用同一套 slash 命令。当前活跃的会话会自动记住，下一条消息会进入它。

## 会话与 Scope 的关系

**Scope** 是渠道里承载一次对话的范围。在 1 对 1 私信里，scope 就是你和 bot。在群里，scope 可以是整个群、单个 thread，或群里某一个人——具体取决于渠道设置（参考 [连接渠道](/zh/docs/channels/)）。

每个 scope 下可以有：

- **一个活跃会话。** 新消息会进入它。
- **多个非活跃会话。** 之前 `/switch` 切走但保留下来的会话。历史完整保留，随时可以切回。
- **已删除的会话。** 已归档、不再出现在 `/list` 中的会话。无法 `/switch` 切回，需要 `/new` 新建。

切换会话不会动底层聊天历史；它只是改变"活跃"标记。Agent 只看到你激活的那一个会话。

## 命令清单

在 bot 所在的渠道里输入。群聊里无需 @bot 也能用命令——像 `/list` 这样被识别的命令总是被视为发给 bot 的。Telegram 和 Discord 会注册原生命令菜单；Slack 可以使用 app manifest 中的原生 slash command。Telegram 菜单插入的 `/list@YourBot` 形式同样可用。

### `/new [name]`

新开一个会话并立刻激活。之前的会话保留在列表里。可以给新会话起一个便于以后查找的名字。

```
/new
/new feat-login
/new prod debug
```

### `/list [page]`

列出当前 scope 下所有会话，活跃的那一条会被标记。列表中的编号在你看到的当前页是稳定的——可以直接用在 `/switch` 或 `/delete` 里。

```
/list
/list 2
```

典型输出：

```
Sessions in this chat (3 total):
▶ 1. 🏷️ «feat-login» · created 12m ago
◻ 2. 🏷️ «prod debug» · created 1h ago
◻ 3. (untitled) · created 2h ago
Use /switch <number|name>, /current, /new, /help.
```

`▶` 表示活跃会话。`🏷️` 表示这个会话有自定义名字。

### `/switch <number|name>`

按编号、名字、id 前缀或标题片段切换。匹配优先级：

1. `/list` 中的数字编号
2. 名字精确匹配（不区分大小写）
3. 渠道会话 id 前缀（`chs_…`）
4. 聊天会话 id 前缀（`cts_…`）
5. 名字前缀（不区分大小写）
6. 聊天标题子串（不区分大小写）

```
/switch 2
/switch feat-login
/switch prod
```

匹配不到会有友好提示。如果目标已被删除，会建议你用 `/new` 新建。

### `/current`

查看当前活跃会话及其创建时间。

```
/current
```

### `/rename [name]`

给当前活跃会话改一个易记的名字。改名后在 `/list` 里会显示 `🏷️` 标记。这不会影响网页工作区里看到的聊天标题。

不带参数运行 `/rename` 会清空已设置的名字，回到默认标题。

```
/rename auth 重构
/rename
```

### `/delete <number|name>`

归档一个会话。聊天历史会保留（在网页工作区中仍可访问），但不再出现在 `/list` 中，也无法 `/switch` 切回。

如果删除的是活跃会话，并且 scope 下还有其他未删除的会话，系统会自动激活最近创建的那一条。如果没有其他会话，下一条消息会自动开启一个新会话。

```
/delete 3
/delete prod debug
```

### `/stop`

取消当前 scope 中正在运行的回答，并丢弃排在它后面的 queued message。不会删除 session 或之前的历史。

```
/stop
```

如果没有正在运行的回答，bot 会明确提示。底层 runtime 停止可能需要短暂时间。

### `/model [name]`

查看当前 Agent model 和可选项，或修改 Agent 级默认 model。修改会影响该 Agent 的所有 session，而不只当前渠道 session。

```
/model
/model model-name-from-list
```

在 Slack、Lark/飞书和 Matrix 中，这个 Agent 级命令要求发送者的 provider ID 已加入 **Operator user IDs**；operator 列表为空时 `/model` 会被禁用。Telegram 和 Discord 允许每个已接受的 channel sender 运行它，因此请相应限制 bot/group/server 访问。

### `/usage`

显示 active session 的 token、cost 和 turn 总量，以及 Agent 最近 30 天的汇总用量。

```
/usage
```

如果 provider 或 model 不上报 cost，结果可能只包含部分数据或显示为零。

### `/history`

显示 active session 最近 8 条消息的紧凑摘要。读取的是 Manyfold session transcript，不是外部聊天平台中未被 Agent 处理的历史消息。

```
/history
```

### `/help`

在渠道里打印这份命令清单。

## 行为说明

- **Slash 命令不会被 Agent 看到。** Bot 自己处理命令并回执，模型看不到你的 `/list`、`/switch` 等。回执只显示给你看。
- **命令绕过群组提及门禁。** 在开启了 mention-only 的群里，与 Agent 对话仍需先 @bot，但被识别的命令（`/new`、`/list`、`/switch` 等）无需 @ 即可运行。Telegram 支持 `/list@YourBot`；Slack 和 Discord 可以发送原生 slash invocation。
- **原生命令的 thread 行为因平台而异。** Slack 原生 slash payload 不包含输入框所在 thread，因此使用 channel-level scope；Discord interaction 包含 channel/thread；文本命令沿用普通消息 scope。
- **Agent 级命令是高权限操作。** `/model` 会修改所有 session 的默认值。Slack、Lark/飞书和 Matrix 要求 operator，且 operator 列表为空时 fail-closed。Telegram 没有 operator list，会把每个已接受 sender 当作 operator，因此 bot 访问权就是安全边界。
- **同一时刻只有一个会话在跑。** 如果某个会话正在 agent 那里处理消息，新消息会等待。切到另一个会话后可以立刻发消息，不会打断那个忙碌的会话。

## 闲置自动重置

长时间运行的聊天容易堆积偏离主题的上下文。可以为渠道配置在 scope 静默一段时间后自动开新会话：设置渠道的 `resetOnIdleMins`（分钟）。当无消息时间超过阈值后，下一条消息会进入一个全新的会话，旧的在后台归档。最长一周（10080 分钟）。留空或填 0 表示关闭。

重置是静默进行的——不会发"已重置"之类的提示——给人的体验是一个干净的对话。旧会话仍保留在 `/list` 中。

## API 与 CLI 访问

也可以在聊天之外管理会话：

- **CLI：** `mf channels sessions list|new|switch|rename|delete` —— 参考 `mf channels sessions --help`。
- **REST：** `GET /channels/:id/scopes`、`GET /channels/:id/sessions`、`POST /channels/:id/sessions`、`PATCH /channels/:id/sessions/:sessionId`、`DELETE /channels/:id/sessions/:sessionId`。

## 另请参阅

- [连接渠道](/zh/docs/channels/)
- [Telegram](/zh/docs/channels/telegram/)
- [Slack](/zh/docs/channels/slack/)
- [Lark 和飞书](/zh/docs/channels/lark/)
- [Discord](/zh/docs/channels/discord/)
- [Matrix](/zh/docs/channels/matrix/)
