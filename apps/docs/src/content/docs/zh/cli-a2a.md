---
title: 用 CLI 调用 peer Agent
description: 使用 mf 发现可调用 peer、发送 A2A 工作并恢复 long-running task。
order: 11
---

# 用 CLI 调用 peer Agent

`mf a2a` 支持两个方向：

- Outbound：调用已授权的 peer Agent 或 raw A2A server。
- Inbound：暴露当前 Agent，并管理 authorized caller。

[A2A API 指南](../api-a2a/)覆盖 inbound exposure 和 External client token。
本页重点说明 outbound call 和 task recovery。

## 发现可调用 peer

```sh
mf a2a status
```

结果列出当前 Agent 可以调用的 peer name/ID，以及 in-flight outbound call。发送时
使用列表中的 name 或 ID。

## 发送工作

```sh
mf a2a send peer-name "Summarize today's open pull requests."
mf a2a send peer-name "Continue the review." --context-id aac_xxx
mf a2a send peer-name "Inspect this file." --input-file ./report.txt
```

默认会等待结果。如果 remote Agent Card 暴露特定 skill，可使用 `--skill <id>`。

调用 raw URL 时，通过 stdin 或 `MF_A2A_BEARER` 提供 bearer：

```sh
printf '%s' "$A2A_TOKEN" |
  mf a2a send https://example.com/a2a "Run the check." --bearer -
```

默认拒绝 HTTP、localhost 和 private target。`--allow-http-localhost` 只用于本地开发。

## Long task

Stream event：

```sh
mf a2a send peer-name "Run the full audit." --stream
```

或提交后立即返回：

```sh
mf a2a send peer-name "Run the full audit." --async --json
mf a2a tasks list --state working
mf a2a tasks get peer-name aat_xxx --wait
```

默认 client deadline 是 900 秒。`--timeout 0` 只会关闭 client deadline，不会移除
server-side task limit。

## 恢复或取消

```sh
mf a2a tasks subscribe peer-name aat_xxx
mf a2a tasks get peer-name aat_xxx
mf a2a tasks cancel peer-name aat_xxx
```

`subscribe` 会重新连接 task SSE stream。断线后先用 `get` 判断状态再决定是否重试；
除非显式复用 context 或 task ID，重新发送 prompt 可能创建另一份工作。

## 管理 inbound access

```sh
mf --agent-id agt_xxx a2a exposure get
mf --agent-id agt_xxx a2a exposure enable
mf --agent-id agt_xxx a2a callers list
```

Exposure 和 caller grant 是两个独立控制。创建 caller 不会自动打开 public exposure。

## 另请参阅

- [通过 A2A 调用 Agent](../api-a2a/)
- [用 mf 编写脚本](../scripting/)
- [CLI 命令参考](../cli-reference/)
