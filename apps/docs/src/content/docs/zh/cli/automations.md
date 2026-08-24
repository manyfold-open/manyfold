---
title: 用 CLI 管理 Automation
description: 创建 schedule、暂停 job、立即触发并查看 automation history。
order: 7
---
Automation 会按 schedule 或按需运行一条 Agent prompt。用 `--agent-id` 或
`MF_AGENT_ID` 选择 Agent。

## 创建 schedule

```sh
mf automations create \
  --agent-id agt_xxx \
  --title "Weekday summary" \
  --prompt "Summarize open work and blockers." \
  --schedule-preset weekdays \
  --rrule 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0' \
  --timezone Europe/London
```

Preset 包括 `hourly`、`daily`、`weekdays`、`weekly` 和 `custom`。每个
schedule 都必须传 iCalendar RRULE 和 IANA timezone；`RRULE:` prefix
可省略。可选 ISO8601 `--dtstart` 用于控制首次触发时间：

```sh
mf automations create \
  --agent-id agt_xxx \
  --title "Monday review" \
  --prompt "Review last week's incidents." \
  --schedule-preset custom \
  --rrule 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' \
  --timezone Europe/London
```

只有这个 job 需要覆盖 Agent 默认 model 时才使用 `--model`。

## 查看和立即触发

```sh
mf automations list --agent-id agt_xxx
mf automations get aut_xxx
mf automations run aut_xxx
```

`get` 包含近期 run；`run` 会立即触发一次，不会修改保存的 schedule。

## 更新、暂停或删除

```sh
mf automations update aut_xxx --status paused
mf automations update aut_xxx --status active
mf automations update aut_xxx --schedule-preset daily --timezone UTC
mf automations update aut_xxx --clear-model
mf automations delete aut_xxx --yes
```

> **警告：** 删除不可恢复。CLI 不会打开 interactive prompt；没有 `--yes` 会直接拒绝执行。脚本请使用 `--json`，mutation 前先核对 automation ID。

## 另请参阅

- [用 mf 编写脚本](/zh/docs/scripting/)
- [用 CLI 查询用量](/zh/docs/cli/usage/)
- [CLI 命令参考](/zh/docs/cli/reference/)
