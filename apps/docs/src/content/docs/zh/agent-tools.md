---
title: Manyfold 与 Agent framework
description: 它们并不是同一层的产品。先分清「模型」、「执行工作的 Agent framework」、「管理与协作平台」和「执行位置」，就能知道它们如何搭配。
order: 6
---
**快速答案**：**Claude Code、Codex、Gemini CLI、OpenClaw、Hermes** 是实际执行工作的 Agent framework；**Manyfold** 是创建、托管、管理、连接并让这些 Agent 与团队协作的平台。Manyfold 不取代它们，而是把它们放进有 workspace、session、terminal、skills、channel 与 runtime 的统一工作环境。

## 开始前准备

- **Agent 工具比较**：先区分模型、coding agent framework、Manyfold 平台与 runtime，再比较各工具的职责。
- **密钥只放在服务端**：优先使用官方文档、最小权限凭据，并在生产环境前完成 staging 验证。

## 先分清四个层次

| 层次 | 产品 | 提供什么 |
| ---- | ---- | -------- |
| **1. 模型与模型供应商** | Anthropic、OpenAI、Google Gemini、OpenRouter | 提供 AI 推理能力与凭据。Manyfold 可连接这些 provider；有些工作区也可能提供 managed model access。 |
| **2. Agent framework** | Claude Code、Codex、Gemini CLI、OpenClaw、Hermes | 接收任务、调用工具、读写文件和执行工作。不同 framework 的强项与操作方式不同。 |
| **3. Agent 平台与控制层** | Manyfold | 创建与托管 Agent，保存 workspace、chat session、files、terminal、model settings、skills、channels、automation、usage 与 runtime 状态。 |
| **4. 运行位置** | Stateful sandbox、Self-owned computer、Cloud computer | 决定 Agent 在 Manyfold 云端隔离环境、你的电脑，或长期运行的云端电脑中执行。 |

## Manyfold 本身是什么？

Manyfold 是一个 Agent workspace 与控制平台，不只是聊天界面。你可以在其中建立 Agent、给它 workspace 和 runtime，并从网页、CLI 或团队 chat 工具与它互动。它会把每个 Agent 的 files、chat sessions、terminal state、settings、skills 和 channel connections 放在一起管理。

因此，Manyfold 解决的是「如何把 Agent 纳入真实工作与团队协作」；它不是另一个 Claude、GPT 或 Gemini 模型，也不是要取代 Claude Code、Codex 或 Gemini CLI。

## 完整比较

| 工具或类别 | 它是什么 | 最适合做什么 | 与 Manyfold 的关系 |
| ---------- | -------- | ------------ | ------------------ |
| **Manyfold** | Agent workspace、控制与协作平台 | 建立、管理、连接和观察多个 Agent 与团队 workflow | 管理与托管 Agent framework；可选择模型与 runtime |
| **Claude Code** | Coding agent framework | Repository work、实现任务、terminal workflow、长时间 coding session | 可作为 Manyfold 中一个 Agent 的 framework |
| **Codex** | Coding agent framework | Codebase 改动、code review、workspace-aware 开发工作 | 可作为 Manyfold 中一个 Agent 的 framework |
| **Gemini CLI** | Coding 与 terminal agent framework | 使用 Google Gemini 的 coding 与一般 terminal automation | 可作为 Manyfold 中一个 Agent 的 framework |
| **Hermes Agent** | Framework-style agent | Connector-heavy workflow 与 background work | 可在 Manyfold 中建立、管理和连接 |
| **OpenClaw** | Framework-style agent | 需要 service、gateway 或 scheduled job 的 tool-rich agent application | 可在 Manyfold 中建立、管理和连接 |

这些定位来自 Manyfold 的 framework 选择说明；具体可用功能、模型与凭据取决于你选择的 framework、provider 和 runtime。

## Manyfold 带来了什么额外能力？

单独使用 coding agent 时，你通常在本地 terminal 与一个 Agent 工作。把它接入 Manyfold 后，Agent 本身仍负责实际任务，但 Manyfold 增加了一个统一的团队与运维层：

- 每个 Agent 有独立、可恢复的 chat session、workspace files 和 terminal access。
- 可管理 model provider、模型设置、usage 与成本。
- 可安装可重复使用的 skills，并建立 automations。
- 可连接 Slack、Lark、Feishu、Telegram、Discord、Matrix 等 team channels。
- 可选择在 sandbox、自己的电脑或 cloud computer 运行，并在产品界面查看 runtime 状态。

## 应该怎样选择？

| 如果你需要 | 先选 |
| ---------- | ---- |
| 只让 AI 协助修改或 review 一个 repository | **Claude Code** 或 **Codex** |
| 既有开发流程已经依赖 Gemini | **Gemini CLI** |
| Connector、服务、后台工作或计划任务 | **Hermes Agent** 或 **OpenClaw** |
| 让多个 Agent 被团队统一管理、连接频道、记录用量或使用不同 runtime | 用 **Manyfold** 管理选定的 framework |

### 一个实际组合示例

工程团队可以在 Manyfold 创建一个 **Codex Agent**，将它运行在 **Self-owned computer**，把 Workspace 指向本机 repository，并用本机凭据或 Manyfold 管理的 provider 作为模型来源。Codex 负责修改代码；Manyfold 负责保存 session、提供团队 chat 入口、管理 runtime 状态和 usage。

### 如果我只用 Claude Code / Codex，不用 Manyfold 可以吗？

可以。它们能独立作为 coding agent 使用。Manyfold 的价值是在需要共享 workspace、统一模型与凭据管理、团队 channel、自动化、多 Agent 协作或多种 runtime 时，提供额外的控制与可见性。

## 常见问题

- **Manyfold 是 Claude Code、Codex 或 Gemini CLI 的替代品吗？**

  不是。它们是不同层次：Claude Code、Codex、Gemini CLI 负责具体的 Agent 工作；Manyfold 负责创建、托管、管理、连接和协作这些 Agent。
- **OpenClaw 与 Hermes 和 Coding Agent 有什么不同？**

  Manyfold 将 Hermes Agent 与 OpenClaw 归为 framework-style agent，更适合 connectors、services、scheduled jobs 或 product workflows；Claude Code、Codex、Gemini CLI 则偏向 codebase 与 terminal 工作。
- **Manyfold 是否提供模型？**

  Manyfold 可以连接 Anthropic、OpenAI、Google Gemini 或 OpenRouter 等 model provider；某些 workspace 也可能有 managed model access。你可依所选 Agent 与设置选择可用的来源。

## 另请参阅

- [Manyfold FAQ](/zh/docs/faq/)
- [mf CLI 指南](/zh/docs/cli/)
- [Runtime 选择指南](/zh/docs/choose-a-runtime/)
- [Create your first agent：framework 与 runtime 选择](/zh/docs/create-agent/)
- [Getting started：Manyfold 能管理的 Agent 工作内容](/zh/docs/getting-started/)
- [Manyfold CLI：管理 Agents、Runtimes、Channels、Automations 和 Skills](/zh/docs/cli/)
