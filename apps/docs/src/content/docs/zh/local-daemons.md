---
title: 注册 Self-owned computer
description: 把自己的笔记本、台式机或 homelab 接入 Manyfold 作为运行环境。
order: 4
---
Self-owned computer 让 Manyfold 把任务路由到你自己的机器，而不是云端 sandbox。`mf` CLI 会在该机器上运行本地 daemon，上报已安装的 coding agent（Claude Code、Codex、Gemini CLI），并按需承接 agent 会话。

适合使用 self-owned computer 的场景：

- 需要直接访问本地仓库或文件系统。
- 机器上已经装好了 CLI 工具链。
- 想用自己的 GPU、网络或算力环境。

## 准备工作

- 在要注册的机器上安装 `mf` CLI。参考 [安装 CLI](/zh/docs/install/)。
- 选择要持有这份注册信息的 [CLI profile](/zh/docs/profiles/)。
- 登录：`mf login`。如果是通过 SSH 连接的无浏览器机器，用 `mf login --no-launch-browser`，然后在任意一台机器的浏览器里完成授权。

最短路径是 `mf setup`：它会完成登录、签发机器 token、注册 host、安装
autostart，并等待 daemon 健康。SSH 环境使用
`mf setup --no-launch-browser`。如果 token 由管理员代为签发，再使用下方的手动流程。

## 第 1 步：申请 token

在网页应用打开 **设置 → Self-owned computers**。在 **注册新机器** 区域给机器起个名字（比如 `laptop` 或 `homelab-1`），点击 **Issue token**。

页面会显示一条可直接粘贴的命令：

```sh
mf daemon register --token ldt_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

Token 只显示一次。**立即复制整条命令**。如果丢了，先撤销旧 token 再申请新的。

## 第 2 步：在目标机器上运行命令

把命令粘贴到要注册的机器的终端里。CLI 会：

1. 在 `~/.manyfold/profiles/<profile>/daemon/daemon.id` 生成稳定的 daemon UUID。
2. 检测已安装的 coding 框架（Claude Code、Codex、Gemini CLI）。
3. 向 API 注册这台机器。
4. 把 daemon 配置写到 `~/.manyfold/profiles/<profile>/daemon/config.json`。

这份注册属于当前选择的 profile。运行 `mf profile show` 可查看 active profile
和准确路径。

输出大致如下：

```text
✓ daemon registered
  daemonId: dmh_…
  apiUrl:   https://api.manyfold.ai/api
  detected: claude-code 1.2.3
Start the daemon now? It will auto-start on login. [Y/n]
```

按 `Enter` 或 `y` 启动 daemon。`mf daemon start` 会安装一份自启单元（macOS 的 launchd LaunchAgent / Linux 的 systemd user unit），之后每次登录都会自动拉起 daemon，崩溃后由系统自动重启 —— 不需要保持终端打开。

无人值守或脚本化场景，加 `-y` 一次性跳过 prompt 并直接启动：

```sh
mf daemon register --token ldt_xxxxxxxx -y
```

## 第 3 步：确认机器上线

回到网页应用的 **设置 → Self-owned computers**。这台机器会出现在 **Connected machines** 列表里，前面是绿点。如果 daemon 超过 45 秒没发心跳，绿点会变灰。

每台机器还会显示当前 **CLI 版本** 和 **启动方式**，例如 Mac 上通过 LaunchAgent 启动会显示 `cli 0.7.0 · autostart · login (launchd)`；如果是从终端直接拉起而没装自启单元，则显示 `cli 0.7.0 · manual`。

在该机器上也可以直接查：

```sh
mf daemon status
mf daemon logs
```

## 第 4 步：在这台机器上创建 Agent

在 **Connected machines** 列表里，点击在线机器旁的 **+ Create agent →**，新建 agent 流程会自动选好这台机器作为 runtime。

也可以打开 **New agent**，选好框架后，把 runtime 选成 **Self-owned computer**。

## 管理 daemon

```sh
mf daemon status              # 进程 + 心跳状态，以及自启单元状态
mf daemon logs                # tail 本地日志
mf daemon start               # 安装自启单元并启动（默认登录级）
mf daemon stop                # 停止 daemon 并移除自启单元
mf daemon doctor              # 诊断注册 / 框架检测问题
```

Daemon 日志在 `~/.manyfold/profiles/<profile>/daemon/daemon.log`。
`mf daemon logs` 会自动解析当前 profile 对应的路径。

`mf daemon start` 和 `mf daemon stop` 都支持 scope selector：

- `--system` —— 把单元装到系统级路径，daemon 在**开机时**就会拉起（不依赖用户登录）。会用到 `/Library/LaunchDaemons`（macOS）或 `/etc/systemd/system`（Linux），需要 `sudo`。
- `--user` —— 显式安装或移除登录时启动的 user unit。

只有 `mf daemon start` 额外支持 `--foreground`。它会在当前终端内联运行，
不修改 autostart unit；关掉终端进程就退出。可用于调试、Windows，或没有
launchd/systemd 的环境（如 WSL1、最小化容器）。自动安装 daemon 目前只支持
macOS 和 Linux；Windows 需要前台进程或自行配置 service manager。

执行 `mf update` 升级 CLI 后，先 `mf daemon stop` 再 `mf daemon start`，让自启单元重新写入新的二进制路径。否则 launchd / systemd 在你手动重启单元前会一直用旧路径。

### 自启动级别

默认的 `mf daemon start` 把 daemon 注册在**登录级（user scope）**：

| 系统  | 路径                                                        | 启动时机   |
| ----- | ----------------------------------------------------------- | ---------- |
| macOS | `~/Library/LaunchAgents/ai.manyfold.daemon.<profile>.plist` | 登录时启动 |
| Linux | `~/.config/systemd/user/mf-daemon-<profile>.service`        | 登录时启动 |

`mf daemon start --system` 装到**系统级**，开机即起，无需登录：

| 系统  | 路径                                                        | 启动时机   |
| ----- | ----------------------------------------------------------- | ---------- |
| macOS | `/Library/LaunchDaemons/ai.manyfold.daemon.<profile>.plist` | 开机时启动 |
| Linux | `/etc/systemd/system/mf-daemon-<profile>.service`           | 开机时启动 |

Unit 名包含 profile，因此 production 和 staging daemon 可以同时运行：

```sh
mf --profile default daemon status
mf --profile staging daemon status
```

系统只会在 daemon **崩溃**（非 0 退出）时自动重启它。`mf daemon stop` 正常退出后 daemon 会一直停着，想再次启动跑 `mf daemon start` 即可。

Linux 登录级 scope 下，daemon 默认在登录时启动。如果希望开机即起（不依赖登录会话），给当前用户开启 lingering：`loginctl enable-linger $USER`。

### Workspace 和 skill 存储

Profile 隔离的是 daemon control plane，不隔离 Agent data。默认情况下所有
profile 共享：

```text
~/.manyfold/workspaces
~/.manyfold/skills
```

如果 host 需要隔离的 root，请在注册时声明：

```sh
mf daemon register --token - \
  --workspace-root /srv/manyfold/workspaces \
  --skills-dir /srv/manyfold/skills
```

这些 root 属于对应 host registration，并会报告给 Manyfold；仅切换 profile
不会移动已有 Agent data。

### 自动更新

由 init unit 管理、连接官方 API 的 standalone daemon 每六小时检查一次所属
release channel，并且只在 idle 时更新。Daemon 忙碌时不会中断 session，而会稍后
重试。可在 daemon 环境中设置 `MF_DAEMON_AUTO_UPDATE=0` 禁用，或设置为 `1`
让自定义部署强制启用。手动运行 `mf update` 后仍需重启 daemon，才能让 init unit
加载新 binary。

## 排错

- **`daemon register requires --token <token>`** — 没传 token。回到网页应用重新复制完整命令。
- **`token must start with ldt_`** — token 被截断了。重新复制。
- **机器一直 offline** — 在机器上跑 `mf daemon status` 确认进程在；同时确认该机器能访问 `api.manyfold.ai` 的 HTTPS 出站。
- **Token already bound** — 一个 token 只能绑一台机器。再注册新机器请申请新的 token。
- **撤销机器** — 在 **设置 → Self-owned computers** 点击 **Revoke**。绑在这台机器上的 agent 会被标记为 stopped；机器上的工作目录文件不会被删。
- **Linux 上报 `systemd not available`** — 当前环境没有可用的 user systemd 会话（常见于 WSL1 和精简容器）。可以在长会话里跑 `mf daemon start --foreground`，或加 `--system`（需要 sudo 和系统级 systemd）。
- **Connected machines 显示 `manual`** — daemon 不是通过 `mf daemon start` 启动的（比如用了 `--foreground` 或旧版本 CLI）。跑 `mf daemon stop && mf daemon start` 重新注册一份自启单元即可。
- **`mf update` 升级后 Connected machines 还显示旧的 CLI 版本** — 系统当前跑的还是已加载到内存的旧二进制。跑 `mf daemon stop && mf daemon start` 让 daemon 在新二进制下重启。
- **从 CLI 0.21 或更早版本升级后机器变成未注册** — CLI 0.22 移除了 pre-profile config 和 daemon fallback。请在目标 profile 中重新运行 `mf login`，签发新的机器 token，并执行 `mf daemon register`。`~/.manyfold/workspaces` 中已有的 Agent workspace 不会被删除。
