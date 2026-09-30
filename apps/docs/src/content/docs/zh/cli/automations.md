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
  --schedule-preset weekdays --at 09:00
```

用 preset 说明何时运行：`hourly`、`daily`、`weekdays` 或 `weekly`，用
`--at HH:MM` 指定时间（默认 09:00；`hourly` 只取分钟），`weekly` 再用
`--day mon … sun` 指定星期几。其他 schedule 改传 iCalendar `--rrule`，preset
此时为 `custom`；`RRULE:` prefix 可省略：

```sh
mf automations create \
  --agent-id agt_xxx \
  --title "Monthly review" \
  --prompt "Review last month's incidents." \
  --rrule 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0'
```

schedule 默认使用本机的 timezone，也可以用 `--timezone` 指定 IANA timezone，例如
`Europe/London`。可选 ISO8601 `--dtstart` 用于控制首次触发时间。`create` 会打印
schedule 和下一次运行时间。

只有这个 job 需要覆盖 Agent 默认 model 时才使用 `--model`。

## 查看和立即触发

```sh
mf automations list --agent-id agt_xxx
mf automations get aut_xxx
mf automations run aut_xxx --wait
mf automations result aut_xxx
```

`get` 包含近期 run；`run` 会立即触发一次，不会修改保存的 schedule。加上
`--wait` 会像 `mf agent send` 一样流式显示这次 run 的回复，结束后说明 run 的结果，
以及是否已发送到 automation 的 channel。Ctrl-C 只停止跟随，run 会继续执行。

`result` 打印最近一次 run 的完整回复，或失败原因；用 `--run aur_xxx` 查看
`get` 列出的 20 次 run 中的某一次。仍在进行的 run 会跟随到结束。run 失败时两个命令都以
1 退出；`--json` 输出 `{ run, text, usage, error }`。

## 更新、暂停或删除

```sh
mf automations update aut_xxx --status paused
mf automations update aut_xxx --status active
mf automations update aut_xxx --schedule-preset daily --at 18:00
mf automations update aut_xxx --at 07:30   # 同一个 preset，换个时间
mf automations update aut_xxx --timezone UTC
mf automations update aut_xxx --clear-model
mf automations delete aut_xxx --yes
```

> **警告：** 删除不可恢复。CLI 不会打开 interactive prompt；没有 `--yes` 会直接拒绝执行。脚本请使用 `--json`，mutation 前先核对 automation ID。

## 另请参阅

- [用 mf 编写脚本](/zh/docs/scripting/)
- [用 CLI 查询用量](/zh/docs/cli/usage/)
- [CLI 命令参考](/zh/docs/cli/reference/)
