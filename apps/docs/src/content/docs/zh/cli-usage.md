---
title: 用 CLI 查询用量
description: 查询 token/cost summary、time series、event、session 和 top Agent。
order: 10
---

# 用 CLI 查询用量

`mf usage` 读取 token 和 cost record。Data command 默认输出 JSON，适合 report
和 monitoring。

## Summary 和 time series

```sh
mf usage summary --from 2026-07-01T00:00:00Z --to 2026-08-01T00:00:00Z
mf usage summary --agent-id agt_xxx
mf usage timeseries --bucket day --from 2026-07-01T00:00:00Z
```

`--from` inclusive，`--to` exclusive。可用 `--framework`、`--runtime-id`、
`--agent-id` 和 `--session-id` 按 framework、runtime、Agent 或 chat session
过滤。

## Event 和 pagination

```sh
mf usage events --limit 200 --framework claude-code
mf usage events --cursor '<next-cursor>'
```

Cursor 是 opaque value，请原样传回，不要解析或推导。

## Session 和 Agent ranking

```sh
mf usage sessions --session-id ses_xxx
mf usage top-agents --limit 10
```

`top-agents` 是 account-wide 操作，agent-bound token 会被拒绝。请使用具备所需权限的
human/account credential。缺失或未知的 cost data 应保持 unknown，不能当作 zero。

## 另请参阅

- [用 mf 编写脚本](../scripting/)
- [用 CLI 管理 Automation](../cli-automations/)
- [CLI 命令参考](../cli-reference/)
