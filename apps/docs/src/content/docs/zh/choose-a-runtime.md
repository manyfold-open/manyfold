---
title: 选择运行环境
description: 比较 stateful sandbox、自有电脑与 cloud computer，并选出适合的一种。
order: 5
---
**快速判断**：不需要碰自己的电脑，选择 **Stateful sandbox**；必须使用自己的 repository、CLI、GPU 或私有网络，选择 **Self-owned computer**；需要全天候运行服务或定时任务，选择 **Cloud computer**。

两种 runtime 都需要一个 Manyfold 账户；选择 self-owned computer 时，还需要一台可联网的 Mac、Linux 或 Windows 电脑。

## 什么是 Stateful sandbox？

Stateful sandbox 是 Manyfold 提供的**隔离云端 workspace**。它可以暂停和恢复，同时保留 Agent 的文件和 session state。官方建议大多数用户从这个 runtime 开始，因为不需要设置自己的电脑或本地 daemon。

## 什么是 Self-owned computer？

Self-owned computer 是你控制的 Mac、Linux 或 Windows 电脑。Manyfold 的 `mf` CLI 会在这台电脑运行本地 daemon，并把 Agent 工作派送到它。因此 Agent 可以使用你允许的本地 Workspace、已安装 CLI、GPU 和网络环境。

## Sandbox 与 Self-owned computer：完整比较

| 面向 | Stateful sandbox | Self-owned computer |
| --- | --- | --- |
| **执行位置** | Manyfold 的隔离云端 workspace | 你控制的 Mac、Linux 或 Windows 电脑 |
| **设置方式** | 创建 Agent 时直接选择；适合快速开始 | 安装并登录 `mf` CLI，注册本地 daemon 后选择 |
| **文件访问** | 使用云端 Agent workspace | 可使用你指定的本地 Workspace、repository 和文件系统 |
| **工具与环境** | 使用 sandbox 中的环境 | 可使用电脑上已安装的 CLI、套件与登录状态 |
| **GPU、VPN 与内网** | 不使用你的本机硬件或私有网络 | 可使用自己的 GPU、VPN、内网及算力环境 |
| **可用性** | 可暂停和恢复，状态仍会保留 | 电脑需开机、联网，且 `mf` daemon 必须运行 |

## 如何选择 runtime？

| 任务 | 选择 |
| --- | --- |
| 不需要使用你的电脑或内部网络 | **Stateful sandbox** |
| 必须修改本机项目，或需要你的 CLI、GPU、VPN、内网 | **Self-owned computer** |
| 需要云端持续运行的服务、connector 或计划工作流 | **Cloud computer** |

### 选择 Sandbox 的典型情况

- 第一次试用 Agent，想快速完成一个 coding 或研究任务。
- 项目与资料可以放在云端 Agent workspace 中。
- 不需要本机 repository、特殊 CLI、GPU、公司 VPN 或私有网络。
- 希望使用隔离环境处理工作，并在之后继续相同 session。

### 选择 Self-owned computer 的典型情况

- Agent 必须修改你电脑正在开发的本地项目。
- 任务依赖本机已安装或已登录的 Codex、Claude Code、Gemini CLI、数据库、SDK 或其他工具。
- 任务需要使用自己的 GPU，或访问公司 VPN、内网服务与本机网络资源。
- 你希望 Agent 在特定本机资料夹执行，同时仍由 Manyfold 团队管理与协作。

![在 Agent 创建流程的「在哪里运行」中选择 Self-owned computer](../../../assets/docs/choose-a-runtime/03-select-self-owned-computer-demo.webp)

*在创建 Agent 时，从「在哪里运行」选择 self-owned computer 或新建 sandbox。*

**想知道如何连接自己的电脑**？阅读 [如何在自己的电脑运行 AI Agent](/zh/docs/run-agents-on-your-computer/)，了解 macOS、Linux、Windows、mf CLI、Workspace 与 Model source。

## 不要把 Cloud computer 与 Sandbox 混在一起

Cloud computer 是第三种选择。官方将它用于需要**持续运行的 process、connector、service 或 scheduled workflow** 的 Agent。它是 Manyfold 云端的长期运行电脑，不等同于一般的 Stateful sandbox，也不依赖你的笔记本保持开机。

## 常见问题

- **Sandbox 有 terminal 和文件吗？**

  有。每个 Agent 都有自己的 chat session、files、terminal access、skills 和 settings。不同之处是这些 workspace 运行在云端 sandbox，还是运行在你自己的电脑。
- **我的电脑关机时，本机 Agent 会怎样？**

  Self-owned computer 上的 Agent 无法接收新的本机工作，直到电脑重新开机、联网并恢复 `mf` daemon。
- **我能同时使用两种 runtime 吗？**

  可以。不同 Agent 可以选不同 runtime；例如一般任务使用 Stateful sandbox，而需要访问本机项目的 Agent 使用 Self-owned computer。

## 另请参阅

- [创建第一个 Agent：选择 framework 与 runtime](/zh/docs/create-agent/)
- [注册 Self-owned computer：本地 daemon 与自有电脑](/zh/docs/local-daemons/)
- [mf CLI 指南](/zh/docs/cli/)
- [Manyfold 快速开始](/zh/docs/getting-started/)
- [使用 workspace：Agent 的 chat、文件与 terminal](/zh/docs/workspace/)
