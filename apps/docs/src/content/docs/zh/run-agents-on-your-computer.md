---
title: 如何在自己的电脑运行 AI Agent
description: 在 macOS、Linux 或 Windows 上连接你的电脑，让 Manyfold 在本地 Workspace、工具链和网络环境中运行 Agent。
order: 6
---
**快速答案**：在 **创建 Agent → 高级 → 在哪里运行**（Create agent → Advanced → Where it runs）中选择 **连接新电脑**（Connect a new computer），在目标电脑完成 `mf setup`，然后回到创建流程选择这台已连接的电脑。

## 开始前准备

- **Manyfold 账号**：你需要能够登录 Manyfold，并有权限创建 Agent。
- **目标运行机器**：准备好要运行 Agent 的 Mac、Linux 或 Windows 电脑，并确认它可以联网。
- **Workspace 与工具**：决定 Agent 要访问的目录，并提前安装要使用的 coding agent CLI。

如果你还不确定该选 sandbox 还是自己的电脑，先阅读[Sandbox 与 Self-owned computer 的比较](/zh/docs/choose-a-runtime/)。

## 什么时候应选择 Self-owned computer？

Self-owned computer 会把 Agent 工作派送到你控制的电脑，而不是云端 sandbox。安装 `mf` CLI 后，本地 daemon 会保持连接、发现可用的 coding agent，并在需要时启动 Agent 会话。

当 Agent 需要直接读写本地 repository 或文件、使用已安装并已登录的 CLI、访问 GPU、VPN、内网或特定开发环境时，选择自己的电脑。Manyfold 仍是团队协作与管理界面；实际的工作目录和工具执行则留在你选择的电脑上。

## 第 1 步：在创建 Agent 时连接新电脑

1. 在 Manyfold 选择 **Create agent**。
2. 展开 **高级**，向下找到 **在哪里运行**。
3. 点击 **连接新电脑**。

![在创建 Agent 的「在哪里运行」区块中，选择「连接新电脑」](../../../assets/docs/run-agents-on-your-computer/03-select-self-owned-computer-demo.webp)

*在创建流程中选择连接新的自有电脑。*

![Manyfold 的「连接新电脑」视窗，显示 macOS 和 Linux 的安装命令及 Windows guide](../../../assets/docs/run-agents-on-your-computer/01-connect-new-computer.webp)

*连接视窗会显示 macOS / Linux 安装命令和 Windows guide。*

## 第 2 步：在目标电脑安装并连接 Manyfold

请在**要运行 Agent 的那台电脑**打开终端机，并依作业系统完成以下步骤。

- **macOS**：打开 Terminal（Applications → Utilities → Terminal，或 Spotlight 搜索 Terminal）。
- **Linux**：打开系统的 Terminal。
- **Windows**：在连接视窗点击 Windows guide，并使用 PowerShell 或 Command Prompt。

### macOS 和 Linux

粘贴并执行以下命令：

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
```

### Windows

1. 在连接视窗中点击 **Windows guide**。
2. 下载 Windows 版 `mf.exe`，解压缩后放进固定资料夹，并将该资料夹加入 Windows `PATH`。
3. 打开 PowerShell 或 Command Prompt，执行：

```sh
mf setup
```

按流程在浏览器中登录并授权 Manyfold。Windows 不会自动安装背景自启动服务；设置完成后，请以以下方式运行 daemon，并保持视窗开启：

```sh
mf daemon start --foreground
```

如需在重开机后持续提供服务，请用 Windows Task Scheduler 或自己的服务管理工具在登录后运行这条命令。

## 第 3 步：登录、授权并确认电脑已连接

安装程序会开启浏览器，让你登录 Manyfold 并授权这台电脑。完成后，`mf` 会注册电脑、检测已安装的 coding agent，并启动本地 daemon。回到 Manyfold；当电脑显示绿色状态与 **connected** 时，点击 **使用这台机器** 继续。

![Manyfold 显示已连接的 demo-mac.local、状态与侦测到的 coding agents](../../../assets/docs/run-agents-on-your-computer/02-machine-connected-demo.webp)

*绿色状态表示这台电脑已可作为 Agent runtime 使用。*

> **安全提醒**：不要公开分享登录网址、授权码、machine token、API key，或包含这些资讯的终端机截图。

## 第 4 步：选择电脑、Workspace 与模型来源

回到 **在哪里运行**，选择刚连接、状态为 **就绪** 的 Self-owned computer。接着设置 Agent 的 **Workspace**，也就是它在该电脑上的工作目录。

- 新 Agent 可保留默认位置：`~/.manyfold/workspaces/{agent-id}`。
- 若要在既有项目工作，填写绝对路径，例如 `/Users/your-name/Projects/my-app`。
- 确认当前电脑使用者对该资料夹有读写权限。

![Workspace 输入框，显示中性的 Manyfold demo 工作目录路径](../../../assets/docs/run-agents-on-your-computer/04-workspace-path-demo.webp)

*为 Agent 选择一个适合且权限正确的本地工作目录。*

### 选择模型来源（Model source）

| 模型来源 | 适用情况 |
| -------- | -------- |
| **Manyfold** | 使用 Manyfold 工作区已经设置、管理或提供的模型，适合团队统一管理 Provider、用量与成本。 |
| **本地配置**（Local config） | 使用这台电脑中所选 coding agent 已有的本地凭据，例如 CLI 登录会话、订阅或该 framework 使用的 API key。 |

![选择 Manyfold 作为模型来源，并显示模型与推理强度设置](../../../assets/docs/run-agents-on-your-computer/05-manyfold-model-source.webp)

*Manyfold 模型来源适合统一的团队管理。*

![选择「本地配置」作为模型来源，可重新检查本机可用的配置](../../../assets/docs/run-agents-on-your-computer/06-local-config-model-source.webp)

*「本地配置」会使用所选本地 framework 的可用凭据。*

如果「本地配置」显示 **未检查**，请重新检查状态，并确认对应的 Claude Code、Codex 或 Gemini CLI 已在该电脑正确安装和登录。若要使用团队或个人 API key，请在 Manyfold 的[模型提供商设置](/zh/docs/model-providers/)中添加、测试并保存 Provider。

## 第 5 步：完成创建并验证 daemon 状态

完成其余 Agent 创建选项后，点击创建。Agent 会在你选定的本机 Workspace 中工作，同时保留在 Manyfold 团队工作区中管理、沟通和查看状态。

```sh
mf daemon status
mf daemon logs
mf daemon doctor
```

在 macOS 与 Linux 上，`mf setup` 会安装登录级的自启动单元，因此通常不需要保持 Terminal 开启。Windows 使用 `--foreground` 时必须保持对应进程运行；机器关机、休眠或 daemon 停止时，绑定在该电脑上的 Agent 无法接收新工作。

**还不确定该使用 Sandbox 还是自己的电脑**？先看 [Sandbox 与 Self-owned computer 对比](/zh/docs/choose-a-runtime/)，再选择运行环境。

## 常见问题

- **Self-owned computer 与 sandbox 有什么区别？**

  Sandbox 在 Manyfold 的云端隔离环境中运行；Self-owned computer 在你自己的电脑上运行，因此可以使用本地文件、工具与网络环境。两者都可由 Manyfold 创建与管理 Agent。
- **我可以使用自己的 Codex 或 Claude Code 订阅吗？**

  可以。选择「本地配置」后，Manyfold 会使用所选本地 framework 的凭据。请先确认 CLI 已安装、可运行且已登录；不同 framework 对订阅与 API key 的支持方式可能不同。sandbox 和 cloud computer 也支持这种方式：创建 Agent 时选择**使用自己的订阅**，然后在其内置终端里完成登录。
- **电脑必须一直开着吗？**

  是。当 Agent 需要在该电脑执行工作时，电脑必须开机、联网，且 `mf` daemon 必须运行。
- **可以连接多台电脑吗？**

  可以。每台电脑各自完成连接后，都会出现在「在哪里运行」的清单中。创建 Agent 时选择它应运行的那一台即可。

## 另请参阅

- [注册 Self-owned computer：daemon、自动启动与排错](/zh/docs/local-daemons/)
- [安装 Manyfold CLI](/zh/docs/install/)
- [学习 mf CLI](/zh/docs/cli/)
- [创建第一个 Agent](/zh/docs/create-agent/)
- [配置模型提供商](/zh/docs/model-providers/)
- [使用 Agent workspace](/zh/docs/workspace/)
