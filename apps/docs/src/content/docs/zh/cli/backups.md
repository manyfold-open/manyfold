---
title: 备份和恢复 Agent
description: 使用 mf 创建 snapshot、恢复 Agent state 并跟踪 restore operation。
order: 8
---
Backup 保存 Agent 可恢复的 state。执行破坏性 runtime 或 Agent 变更前先创建
backup；无法承受丢失的文件还应保留独立副本。

## 创建和列出 backup

```sh
mf backups create agt_xxx
mf backups list --agent-id agt_xxx
```

Restore 或删除时使用返回的 backup ID。脚本需要准确保存 ID 时请加 `--json`。

## 恢复 Agent

Restore 会替换 Agent 当前 state：

```sh
mf backups restore agt_xxx --backup-id abk_xxx --yes
```

CLI 要求显式传入 `--yes`，不会打开 interactive prompt。传入之前：

1. 核对 Agent ID 和 backup ID。
2. 停止或完成仍在写入 Agent 的工作。
3. 如果需要 rollback，先为当前 state 创建新的 backup。

Unattended restore 需要 machine-readable output 时再加 `--json`。

Restore 命令返回 operation ID。持续检查直到 operation 进入 terminal state：

```sh
mf backups get-restore abr_xxx
```

请求被接受不等于恢复完成；必须用 `get-restore` 核验最终状态。

## 删除 backup

```sh
mf backups delete abk_xxx --yes
```

> **警告：** 删除不可恢复；没有 `--yes` 时 CLI 会拒绝执行。请先确认没有 rollback 或 audit workflow 仍引用它。

## 另请参阅

- [用 CLI 管理 Agent](/zh/docs/cli/agents/)
- [用 CLI 管理 Runtime](/zh/docs/cli/runtimes/)
- [CLI 命令参考](/zh/docs/cli/reference/)
