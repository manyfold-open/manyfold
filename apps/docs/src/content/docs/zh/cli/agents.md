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

## 创建 sprites.dev coding Agent

`mf agent create` 当前只会在 sprites.dev 上创建新 Agent，支持 Claude Code、
Codex、Gemini CLI 和 Pi：

```sh
mf agent create review-bot \
  --framework codex \
  --openai-api-key "$OPENAI_API_KEY"
```

Provider key 可以来自 framework 对应的环境变量。避免把 literal key 放进 shell
history。每个 framework 的 base URL 和 model option 请查看
`mf agent create --help`。Pi 需要同时传 `--pi-api-key` 和
`--pi-provider anthropic|openai|google`，说明这把 key 属于哪个厂商。

这个命令不会创建 daemon、Kubernetes、cloud-computer、external、Hermes 或
OpenClaw Agent。完整 framework/runtime matrix 请使用网页
**New agent** 流程。在现有 multi-agent runtime 中增加 framework Agent，请使用
`mf runtime agents add`。

## 更新或删除 Agent

```sh
mf agent update agt_xxx --name reviewer
mf agent update agt_xxx --model gpt-5.6
mf agent update agt_xxx --clear-model
mf agent delete agt_xxx --yes
```

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
`--config @file.json`。

## 另请参阅

- [创建第一个 Agent](/zh/docs/create-agent/)
- [用 CLI 管理 Runtime](/zh/docs/cli/runtimes/)
- [备份和恢复 Agent](/zh/docs/cli/backups/)
- [CLI 命令参考](/zh/docs/cli/reference/)
