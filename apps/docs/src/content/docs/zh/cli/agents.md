---
title: 用 CLI 管理 Agent
description: 通过 mf 创建、查看、更新、删除和配置 Manyfold Agent。
order: 5
---
`mf agent` 管理 Agent record 和 credential。Model 设置使用独立的
`mf model-config`；已有 runtime 内托管的 Agent 使用 `mf runtime agents` 管理。

## 查看 Agent

```sh
mf agent list
mf agent get agt_xxx
mf agent storage-usage agt_xxx
```

脚本可加 `--json`。Agent runtime identity 默认只看到自己的 context；runtime 的账户级
访问需要显式 `--account` 与对应 consent grant，human login 保留账户访问权限。

## 存储

```sh
mf sandbox storage-usage --json
mf --account sandbox storage-usage --json
mf agent storage-usage agt_xxx --json
```

第一条命令返回当前 sandbox 缓存的整机文件系统用量。在 Agent runtime 外使用时，
指定 `--agent-id agt_xxx` 或选择 `--account`。账户报告每台 sandbox 只计算一次，
包含空 sandbox 和休眠 sandbox，并按存储用量排序。Runtime 的账户读取需要
`agents:read` consent。报告包含 `scope`、字节单位、测量时间和 freshness，读取不会唤醒休眠 sandbox。

`agent storage-usage` 是 Agent 自有路径诊断，不是账户存储总计。它只在 sandbox 运行时
测量 workspace 和配置目录；休眠或不可用时返回未知路径值，并单独保留缓存的 sandbox
读数。未知值为 `null`，不伪装成零。

Agent record 的 `workspaceBytes` 和 `workspaceMeasuredAt` 成对返回，替代语义混杂的
`storageBytes` 和 `storageMeasuredAt`。Workspace 值是目录原始大小，不能相加推算整机用量。
Sandbox 报告另有已知路径归属，处理嵌套目录和路径别名，但不声称精确分摊文件系统或账单。
测量缺失或不一致时，归属保持未知。

`agent list --json` 返回 `{ "scope": "agent" | "account", "agents": [...] }`。
这是 API/CLI 的破坏性契约变更，应一起升级。存储命令和 Agent list/get 会明确拒绝旧版的歧义响应。

## 创建 coding Agent

`mf agent create` 创建 Claude Code、Codex、Gemini CLI、Pi 或 Antigravity CLI
Agent。需要说明 Agent 的 model 由谁提供：

```sh
mf agent create review-bot --framework codex --model-provider managed
mf agent create review-bot --model-provider subscription
mf agent create review-bot --framework codex --model-provider "Team OpenAI" --model gpt-6-sol
printenv OPENAI_API_KEY | mf agent create review-bot --framework codex --openai-api-key -
```

- `managed` 使用 Manyfold 托管模型。
- `subscription` 使用你自己在该 framework 厂商的订阅。新 sandbox 还没有登录：
  打开命令输出的聊天链接，按其中的登录卡片操作；或在 sandbox 的 terminal 中运行
  命令输出的登录命令。
- Provider id 或名称使用你在网页中保存并测试过的 model provider。
  `mf model-providers list --framework codex` 列出哪些 provider 能服务该
  framework，以及 `--model` 可以选哪些模型。对 Claude Code，`sonnet` 这样的
  别名始终指向测试过的最新 Sonnet，写具体 id 则固定为那一个；
  `--model "Sonnet 5"`、`--model "sonnet 4.5"` 这类写法只要能唯一对应一个模型
  也可以。如果模型是在 provider 上次测试之后才发布的，先运行
  `mf model-providers test <provider>`。
- Key flag 使用你自己的 key。传 `-` 时从 stdin 读取，key 不会进入 shell
  history。CLI 不读取环境变量中的 key。Pi 需要同时传 `--pi-api-key` 和
  `--pi-provider anthropic|openai|google`，说明这把 key 属于哪个厂商。

每次创建都会新建一个 sandbox，并计入套餐的 sandbox 数量。要把 Agent 加到已有的
sandbox，用 `--sandbox` 指定：

```sh
mf sandbox list
mf agent create second-bot --sandbox sandbox-2
```

加入一个已经在运行该 framework 的 sandbox 时，Agent 与其中已有的 Agent 共用
credential，因此不要传 model 来源；要使用该 sandbox 自己的登录，传
`--model-provider subscription`。删除 Agent 不会释放它的 sandbox：sandbox 上的
Agent 都删除后，用 `mf sandbox delete <id|name> --yes` 删除 sandbox。
`mf sandbox update <id|name>` 更新 sandbox 上的 Manyfold CLI，与 Update Center
的效果相同；要安装指定的 build，传 `--to <version>`。

命令会在每一步完成时打印进度。连接中断时会自动重新接上。按 Ctrl-C 之后创建仍会
继续：再次运行同一条命令即可接上，或拿到已经创建好的 Agent。

这个命令不会创建 daemon、Kubernetes、cloud-computer、external、Hermes 或
OpenClaw Agent。完整 framework/runtime matrix 请使用网页
**New agent** 流程。按 runtime id 向 runtime 中增加 Agent，请使用
`mf runtime agents add`。

## 与 Agent 对话

```sh
mf agent send agt_xxx "总结一下未合并的 pull request"
git diff | mf agent send agt_xxx -
mf agent send agt_xxx -c "那个失败的测试呢？"
mf agent send agt_xxx "这张截图里是什么？" --file ./shot.png
```

`mf agent send` 发送一条消息并打印回复：回复写到 stdout，在终端里流式输出，
通过管道时一次性输出；工具调用和结尾信息（model、token、费用、session）写到
stderr。每次运行都会新建 session，除非用 `--session <id>` 指定，或用 `-c`
继续最近用过的那个。消息也可以从 stdin 读取（`-`）。`--file` 会把本地文件上传到
Agent 的 workspace 并作为附件发送，图片也一样；一条消息最多 10 个文件，每个
25 MiB。`--json` 把这一轮输出为一个对象。按 Ctrl-C 会停止这一轮。

`mf agent chat agt_xxx` 在终端的提示符下进行同样的对话，每行一条消息：`/new`
开始新的 session，`/exit` 或 Ctrl-D 退出。`mf agent chat agt_xxx --file ./design.png`
把文件或图片附在第一条消息上，作为整段对话的上下文。

## 更新或删除 Agent

```sh
mf agent update agt_xxx --name reviewer
mf agent update agt_xxx --model sonnet
mf agent delete agt_xxx --yes
```

`--model` 的写法与 `mf agent create` 相同：`sonnet` 这样的别名、具体 id，或
`"Sonnet 5"` 这样的名称。Coding Agent 的 model 保存在它的 model 配置里，所以会
改到那里，效果与 `mf model-config update --model` 相同。model 配置中没有的
model 会被拒绝，并列出可选的 model。新 model 从下一条消息起在所有 session 中生效，
已经打开的对话也一样。

> **警告：** 删除不可恢复。CLI 不会打开 interactive prompt；没有 `--yes` 会直接拒绝执行。只有已独立核对 target ID，且重要 workspace 已有 backup 时，才传入该 option。

## Credential

```sh
mf agent credentials get agt_xxx
mf agent credentials reveal agt_xxx
mf agent credentials update agt_xxx --body @credentials.json
```

`get` 只返回 metadata，不返回 secret。`reveal` 默认 mask，只有 `--show` 才显示
plaintext。不要把 plaintext 输出写进日志、聊天、issue tracker 或 shell history。

Update body 使用 framework-specific `UpdateAgentCredentialsBody`。修改前先检查当前
metadata 和 command help。部分 gateway-style framework 的 credential 变更需要
rebuild 才会应用到 running service。

## Model 配置

```sh
mf model-config get agt_xxx
mf model-config update agt_xxx --model gpt-5.6 --json
mf model-config update agt_xxx --clear-model --clear-config
mf model-config refresh-models agt_xxx
```

`--source` 可选 `platform` 或 `runtime-local`。JSON config 可 inline 传入，也可使用
`--config @file.json`。`--clear-model` 让 Agent 回到 framework 的默认 model：
使用 model provider 时，是新 Agent 在该 provider 上会得到的 model；使用订阅登录时，
是 CLI 自己的默认 model。

## 另请参阅

- [创建第一个 Agent](/zh/docs/create-agent/)
- [用 CLI 管理 Runtime](/zh/docs/cli/runtimes/)
- [备份和恢复 Agent](/zh/docs/cli/backups/)
- [CLI 命令参考](/zh/docs/cli/reference/)
