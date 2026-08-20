---
title: 用 mf 编写脚本
description: 在脚本和 CI 中使用 JSON、稳定 exit code、profile 和安全 credential。
order: 4
---

# 用 mf 编写脚本

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

## 不提供 JSON mode 的命令

以下命令使用 raw stream、interactive flow 或 long-lived process，因此不提供 JSON：

- `mf files read`
- `mf daemon logs`
- `mf daemon start`
- `mf daemon register`
- `mf daemon stop`
- `mf setup`
- `mf update`

请用 `mf <command> --help` 确认已安装版本的能力。

## Credential

长期运行的 host 优先使用保存的 profile。临时 CI 可通过受保护的环境变量或 stdin
提供 token：

```sh
printf '%s' "$MF_CI_TOKEN" |
  mf --api-url https://api.manyfold.ai/api --token - whoami --json
```

避免直接写 `--token <value>`，因为参数可能出现在 shell history 和 process list。
不要记录 `MF_TOKEN`、`MF_API_TOKEN`、credential reveal，或
`~/.manyfold/profiles/<name>/` 下的文件。

## Timeout 和版本漂移

`MF_HTTP_TIMEOUT` 控制普通 API 请求。纯数字表示秒，也支持 `ms`、`s`、`m` 和
`h` duration suffix。

诊断输出应包含 `mf --version`，并按已安装 binary 验证语法：

```sh
mf --version
mf automations create --help
```

## 另请参阅

- [Profile 和环境](../profiles/)
- [CLI 命令参考](../cli-reference/)
- [Manyfold CLI](../cli/)
