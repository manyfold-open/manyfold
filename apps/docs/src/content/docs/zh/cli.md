---
title: Manyfold CLI
description: 使用 mf 在终端中管理 Agent、runtime、channel、文件和 automation。
order: 2
---

# Manyfold CLI

`mf` CLI 是 Manyfold 的终端入口，适用于交互式管理、脚本、CI job 和连接自有计算机。它以 macOS、Linux 和 Windows 独立二进制形式分发，日常使用不需要 Node.js。

先[安装 CLI](../install/)，然后登录：

```sh
mf setup
mf whoami
mf --help
```

`mf setup` 会在一个流程里完成登录、注册当前机器并启动 local daemon。若只需要
client，可在安装时跳过 setup，之后单独运行 `mf login`。

## 可以管理什么

| 任务               | 命令                               | 能力示例                                                                           |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------- |
| 首次设置           | `mf setup`                         | 一次完成登录、机器注册和 daemon 启动。                                             |
| 认证和身份         | `mf login`、`mf whoami`、`mf auth` | 登录、查看当前身份、申请缺少的 capability。                                        |
| Agent              | `mf agent`                         | 列出、查看、创建、更新、删除 Agent，配置凭证并查看存储用量。                       |
| Runtime            | `mf runtime`                       | 查看和管理 Agent runtime、托管的 framework agent、control UI 和 Hermes dashboard。 |
| Model 配置         | `mf model-config`                  | 读取/更新 Agent model 配置并刷新 model 列表。                                      |
| Channel            | `mf channels`                      | 创建、更新、注册、测试 IM channel，通过 channel 发消息并管理 session。             |
| Automation         | `mf automations`                   | 创建/更新 schedule、查看运行记录或立即触发一次运行。                               |
| Runtime 文件       | `mf files`                         | 列出、读取、写入、移动和删除 Agent runtime 暴露的文件。                            |
| Backup             | `mf backups`                       | 创建/列出 backup、恢复 Agent 并查看 restore 状态。                                 |
| Skill              | `mf skills`                        | 发现、安装、启用/禁用和卸载 Agent skill。                                          |
| Usage              | `mf usage`                         | 查询汇总、时间序列、event、session 用量和 top agent。                              |
| Connection         | `mf connections`                   | 列出当前 Agent 或账号可用的 connection。                                           |
| Agent-to-agent     | `mf a2a`                           | 查看 Agent Card、调用已授权 peer，并跟踪 A2A task。                                |
| 自有计算机         | `mf daemon`                        | 注册机器、安装 autostart、查看状态/日志并诊断 framework。                          |
| Profile 和环境     | `mf profile`                       | 查看、选择和删除隔离的 CLI control-plane profile。                                 |
| CLI 生命周期和帮助 | `mf update`、`mf help`             | 检查/安装 CLI 更新，查看面向用户或 Agent 的帮助。                                  |

执行写入或破坏性操作前先运行 `mf <command> --help`，查看当前版本准确的参数和 flag。已安装 CLI 的 help 是对应版本的精确参考。

## 常用工作流

### 查看 Agent

```sh
mf agent list
mf agent get agt_xxx
mf runtime list
mf model-config get agt_xxx
```

### 操作 channel

```sh
mf channels list --agent-id agt_xxx
mf channels test chn_xxx
mf channels sessions list chn_xxx --scope-key '<scope>'
```

Provider 配置见[连接渠道](../channels/)，聊天命令模型见[切换会话](../channels/session-switching/)。

### 读写 runtime 文件

```sh
mf files roots agt_xxx
mf files list agt_xxx workspace
mf files read agt_xxx workspace/README.md
mf files write agt_xxx workspace/note.txt --content 'hello'
```

整个文件的传输用 `upload` 和 `download`。两者都是流式的，传大文件不要求文件大小能装进内存；下载中断也不会破坏本地已有文件：

```sh
mf files upload ./report.csv workspace/report.csv --agent-id agt_xxx
mf files download workspace/report.csv ./report.csv --agent-id agt_xxx
```

设置了 `--agent-id`（或 runtime 里的 `MF_AGENT_ID`）之后，任何 `mf files` 命令都可以省略 agent 参数：`mf files ls workspace`。

路径必须位于 Agent runtime 暴露的 file root 内。`mf files roots` 会给出每个 root 的上传/下载上限；超限的上传在传输开始前就会被拒绝。

### 管理 automation

```sh
mf automations list --agent-id agt_xxx
mf automations get aut_xxx
mf automations run aut_xxx
```

当前 schedule 和 payload 参数请查看 `mf automations create --help` 或 `update --help`。

### 连接自己的机器

```sh
mf daemon register --token ldt_xxx
mf daemon status
mf daemon doctor
```

Token 签发、autostart 和故障排查见[注册自有计算机](../local-daemons/)。

## 认证和上下文

普通终端使用 `mf login` 打开浏览器认证，并把 CLI profile 保存在本机。使用 `mf whoami` 确认当前账号。如果终端所在机器本身没有浏览器（例如 SSH 会话），加上 `--no-launch-browser`，改用粘贴授权码的方式登录。参考 [安装 CLI](../install/)。

以下全局选项可为单条命令覆盖当前上下文：

| 选项或环境变量                    | 用途                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--profile <name>` / `MF_PROFILE` | 选择隔离的 CLI profile；stable binary 默认使用 `default`，dev binary 默认使用 `staging`。                        |
| `--api-url <url>` / `MF_API_URL`  | 使用不同的 Manyfold API 部署。                                                                                   |
| `--token <token>` / `MF_TOKEN`    | 为当前 shell 或命令覆盖已保存凭证；用 `--token -` 从 stdin 读取，直接传值可能出现在 shell history 和进程列表中。 |
| `--agent-id <id>` / `MF_AGENT_ID` | 为支持该参数的命令选择 Agent 上下文。                                                                            |
| `--account`                       | 明确操作整个账号，而不是仅操作当前 Agent 上下文；可能需要用户授权。                                              |
| `MF_HTTP_TIMEOUT`                 | 设置普通 API 请求的超时时间，默认值为 `30s`；纯数字按秒解析，也可使用 `ms`、`s`、`m` 或 `h` 后缀。               |

如果要在同一台机器上使用多个 Manyfold 环境，请先阅读
[Profile 和环境](../profiles/)。

大多数资源命令支持 `--json`。成功 payload 写到 stdout，结构化错误写到 stderr，
并使用稳定的 exit code。完整契约见[用 mf 编写脚本](../scripting/)。

## Agent 身份和权限

在 Manyfold 托管的 Agent runtime 中，`mf` 可以使用注入的 Agent identity，无需交互登录。对当前 Agent 的操作会自动限定 scope；跨账号或访问其他 Agent 资源可能需要显式 grant。

Agent 报告缺少 capability 时，只申请所需 scope：

```sh
mf auth ensure --scopes channels:read,channels:edit
```

命令会生成需要用户批准的 consent URL。不要分享或打印底层 token。

## 更新和排查

```sh
mf update --check
mf update
mf help
```

- 已安装的 standalone binary 可在 macOS、Linux 和 Windows 上自行更新。下载内容会经过 SHA-256 校验并由进程内置逻辑解压，不依赖系统 `tar` 或 `unzip` 命令。
- 参数被拒绝时运行 `mf <command> --help`；不同 CLI 版本的命令可能变化。
- 认证或账号不符合预期时运行 `mf whoami`。
- 自有计算机或本地 framework 出现问题时运行 `mf daemon doctor`。
- 更新正在运行的 local daemon 后请重启，使 autostart service 使用新二进制。

## 另请参阅

- [安装 CLI](../install/)
- [Profile 和环境](../profiles/)
- [用 mf 编写脚本](../scripting/)
- [CLI 命令参考](../cli-reference/)
- [注册自有计算机](../local-daemons/)
- [用 CLI 管理 Agent](../cli-agents/)
- [用 CLI 管理 Runtime](../cli-runtimes/)
- [用 CLI 管理 Automation](../cli-automations/)
- [备份和恢复 Agent](../cli-backups/)
- [用 CLI 管理 Skill](../cli-skills/)
- [用 CLI 查询用量](../cli-usage/)
- [用 CLI 调用 peer Agent](../cli-a2a/)
- [连接渠道](../channels/)
