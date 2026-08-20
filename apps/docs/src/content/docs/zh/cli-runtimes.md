---
title: 用 CLI 管理 Runtime
description: 查看 runtime、管理托管 Agent，并控制 runtime UI。
order: 6
---

# 用 CLI 管理 Runtime

Runtime 是承载一个或多个 Agent 的执行环境。使用 `mf runtime` 查看该环境并管理
runtime-level service。

## 查看或删除 runtime

```sh
mf runtime list
mf runtime get art_xxx
```

删除 runtime 会销毁底层 sprite 或 pod，并级联删除其中托管的 Agent。删除前请核对
runtime ID、备份重要 Agent，并查看 `mf runtime get`。该命令会立即执行，不会打开
confirmation prompt：

```sh
mf runtime delete art_xxx
```

Automation 可使用 `--json`。

## 管理托管的 framework Agent

Multi-agent runtime 可以托管额外的 framework Agent：

```sh
mf runtime agents list art_xxx
mf runtime agents add art_xxx --name reviewer --model gpt-5.6
mf runtime agents add art_xxx --name clone --clone-from agt_source
mf runtime agents remove agt_xxx --yes
```

Remove 命令接收的是 **Agent ID**，不是 runtime ID。Coding Agent 还可设置
`--workspace <path>`。删除不可恢复，并且必须显式传入 `--yes`。

## Control UI

支持的 runtime 可以暴露 control UI sidecar：

```sh
mf runtime control-ui enable art_xxx
mf runtime control-ui get-url art_xxx
mf runtime control-ui disable art_xxx
```

把返回 URL 当作临时 access information，不要发布到日志或公开 issue。

## Hermes dashboard

Hermes runtime 有独立 dashboard lifecycle：

```sh
mf runtime dashboard enable art_xxx
mf runtime dashboard disable art_xxx
```

这些命令只适用于 Hermes；不兼容的 runtime/framework combination 会失败。

## 另请参阅

- [用 CLI 管理 Agent](../cli-agents/)
- [注册 Self-owned computer](../local-daemons/)
- [CLI 命令参考](../cli-reference/)
