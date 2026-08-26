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

脚本可加 `--json`。Agent runtime identity 默认只看到自己的 context；human login
需要显式 account-wide access 时可加 `--account`。

## 创建 sprites.dev coding Agent

`mf agent create` 当前只会在 sprites.dev 上创建新 Agent，支持 Claude Code、
Codex 和 Gemini CLI：

```sh
mf agent create review-bot \
  --framework codex \
  --openai-api-key "$OPENAI_API_KEY"
```

Provider key 可以来自 framework 对应的环境变量。避免把 literal key 放进 shell
history。每个 framework 的 base URL 和 model option 请查看
`mf agent create --help`。

这个命令不会创建 daemon、Kubernetes、cloud-computer、external、Hermes、
OpenClaw 或 NarraNexus Agent。完整 framework/runtime matrix 请使用网页
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
