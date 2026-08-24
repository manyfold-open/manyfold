---
title: Profile 和环境
description: 隔离不同 Manyfold 环境的 credential 和 local daemon。
order: 3
---
Profile 是一个 Manyfold 环境在本机的 control-plane state，包含该环境的 API URL、
credential、pending login、daemon registration、日志、进程状态和 control socket。

同一台机器需要连接 production、staging、[自托管部署](/zh/docs/self-hosting/)或多个账号时，请使用不同
profile。

## 选择 profile

选择顺序如下：

1. Root option：`--profile <name>`
2. 环境变量：`MF_PROFILE`
3. Binary channel 默认值：stable 使用 `default`，dev 使用 `staging`

```sh
mf --profile default whoami
MF_PROFILE=staging mf whoami
mf profile show
mf profile list
```

名称长度为 1–32，只能包含小写字母、数字、`_` 或 `-`，并且必须以字母或数字开头。

## 分别登录和注册每个环境

Login 和 daemon registration 都属于当前选择的 profile：

```sh
mf --profile default login
mf --profile default daemon register --token -

mf --profile staging login --api-url https://api.my-deploy.example/api
mf --profile staging daemon register --token -
```

每个 profile 都有独立 autostart unit，因此多个 daemon 可以同时运行。
`login`、`daemon register`、`daemon start`、`daemon status` 和
`daemon stop` 必须使用同一个 profile。

## 哪些内容会隔离

默认 layout：

```text
~/.manyfold/
├── profiles/<name>/
│   ├── config.json
│   ├── pending-login.json
│   └── daemon/
├── workspaces/
├── skills/
└── update-channel.json
```

Profile 会隔离 credential 和 daemon control state，但**不会**隔离：

- `~/.manyfold/workspaces` 中的 Agent workspace
- `~/.manyfold/skills` 中的 host skill store
- `~/.claude`、`~/.codex` 等 framework home
- 已安装的 `mf` binary 及其 update channel

Agent ID 全局唯一，因此不同 profile 可以安全共享默认 data plane。如果 host
需要单独的存储，可在 `mf daemon register` 时声明 `--workspace-root` 和
`--skills-dir`。

> **警告：** 不要打印或复制 profile 的 `config.json` 或 daemon 文件，其中包含 credential 等敏感状态。

## 查看或删除 profile

```sh
mf profile show
mf profile show staging --json
mf profile list
mf profile delete staging
```

删除 profile 会移除 credential、pending login、daemon state 和 init unit，
不会删除机器共享的 Agent workspace 或 skill。正在运行的 daemon 会阻止删除，
需要先用同一 profile 停止它。删除 `default` 还必须加 `--force`。

## Release channel 和 profile

`mf update --channel dev|stable` 会替换机器上唯一的 binary，并在机器级记住所选
update channel；它不会移动或改写 profile data。

如果没有设置 `--profile` 或 `MF_PROFILE`，从 stable binary 切换到 dev binary
时，默认选择会从 `default` 变为 `staging`。切换 channel 后先运行
`mf profile show`，确认下一条命令会使用哪份 credential 和 daemon。

## 从 CLI 0.21 或更早版本升级

CLI 0.22 移除了旧的 flat config 和 daemon fallback。升级后：

1. 选择目标 profile。
2. 运行 `mf login`。
3. 在 **设置 → Self-owned computers** 签发新的机器 token。
4. 运行 `mf daemon register`，然后启动 daemon。

已有的 `~/.manyfold/workspaces` 和 `~/.manyfold/skills` data 会保留。

## 另请参阅

- [安装 CLI](/zh/docs/install/)
- [注册 Self-owned computer](/zh/docs/local-daemons/)
- [CLI 命令参考](/zh/docs/cli/reference/)
