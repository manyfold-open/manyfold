---
title: 用 mf 编写脚本
description: 在脚本和 CI 中使用 JSON、稳定 exit code、profile 和安全 credential。
order: 4
---
CLI 会把 machine-readable payload 和人类诊断信息分开，让脚本能够可靠处理成功和失败。

## 显式选择 context

无人值守 job 应固定 profile 和 Agent：

```sh
export MF_PROFILE=default
export MF_AGENT_ID=agt_xxx
mf whoami --json
```

只有明确需要 account-wide access 时才使用 `--account`。Agent identity 操作自己的
资源不需要 grant；访问其它 Agent 或整个账号可能需要用户批准 scope。

## JSON 输出

Data 和 mutation command 通常支持 `--json`：

```sh
mf agent list --json | jq -r '.[].id'
mf automations get aut_xxx --json > automation.json
```

成功时，stdout 只包含使用两空格缩进的 raw JSON payload；human progress 写到
stderr。Channel 和 credential 输出仍会 redact，`mf login --json` 永远不会打印
bearer token。

不加 `--json` 时，list 命令输出带表头的表格。表格是给人看的，列可能会变；脚本
请使用 `--json`。

失败时，stderr 使用下面的结构：

```json
{
    "error": {
        "code": "not_found",
        "status": 404,
        "message": "…",
        "hint": "…"
    }
}
```

`status` 和 `hint` 只在可用时出现。CLI 不会把未解析的 response body 放进 error
envelope。

Plan limit 或 quota（`CHANNEL_LIMIT_REACHED`、`ACTIVE_HOURS_QUOTA_REACHED` 以及其它
`*_LIMIT_REACHED` / `*_QUOTA_REACHED` code）还会带上 `details`，包含 `current`、
`limit` 和 `planName`。它和其它 `403` 一样退出码为 `3`，`hint` 会说明该释放什么。

## Exit code

| Code | 含义                                           |
| ---- | ---------------------------------------------- |
| `0`  | 成功                                           |
| `1`  | 其它 server 或 runtime failure                 |
| `2`  | 网络失败或 timeout                             |
| `3`  | Authentication 或 authorization（`401`/`403`） |
| `4`  | Resource 不存在（`404`）                       |
| `5`  | CLI usage 或请求无效（`400`/`422`）            |

先按 exit code 分支，需要详细信息时再解析 stderr：

```sh
if result="$(mf agent get agt_xxx --json 2>mf-error.json)"; then
  printf '%s\n' "$result"
else
  code=$?
  jq '.error' mf-error.json >&2
  exit "$code"
fi
```

执行检查的命令是例外：`mf doctor`、`mf model-providers test`、`mf channels test`
和 `mf channels register` 在检查失败时退出码为 `1`，但报告仍输出到 stdout，stderr
为空。脚本请读取报告里的 `ok`（`mf doctor --json` 还可以读每项检查的 `status`）。
`mf updates apply` 同样在有更新失败时退出 `1`，每一项的结果都输出到 stdout。
`mf updates list` 即使它汇总的某个列表没加载出来也退出 `0`，那个列表会出现在
`errors` 里。

## 不提供 JSON mode 的命令

以下命令使用 raw stream、interactive flow 或 long-lived process，因此不提供 JSON：

- `mf files read`
- `mf daemon logs`
- `mf daemon start`
- `mf daemon register`
- `mf daemon stop`
- `mf setup`

请用 `mf <command> --help` 确认已安装版本的能力。

## Credential

长期运行的 host 优先使用保存的 profile。临时 CI 可通过受保护的环境变量或 stdin
提供 token：

```sh
printf '%s' "$MF_CI_TOKEN" |
  mf --api-url https://api.manyfold.ai/api --token - whoami --json
```

> **警告：** 避免直接写 `--token <value>`，因为参数可能出现在 shell history 和 process list。不要记录 `MF_TOKEN`、`MF_API_TOKEN`、credential reveal，或 `~/.manyfold/profiles/<name>/` 下的文件。

## Timeout 和版本漂移

`MF_HTTP_TIMEOUT` 控制普通 API 请求。纯数字表示秒，也支持 `ms`、`s`、`m` 和
`h` duration suffix。其它取值会让命令在发出请求之前报错退出。

诊断输出应包含 `mf --version`，并按已安装 binary 验证语法：

```sh
mf --version
mf automations create --help
```

## 另请参阅

- [Profile 和环境](/zh/docs/profiles/)
- [CLI 命令参考](/zh/docs/cli/reference/)
- [Manyfold CLI](/zh/docs/cli/)
