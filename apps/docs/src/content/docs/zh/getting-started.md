---
title: 快速开始
description: 了解 Manyfold 的能力，以及创建第一个 Agent 的最短路径。
order: 1
---

# 快速开始

Manyfold 可以帮你创建托管的 AI Agent，为它分配工作区，并通过网页、CLI 或团队聊天工具与它协作。

你可以先从 Claude Code、Codex 或 Gemini CLI 这类 coding agent 开始；当工作流需要长期运行能力时，再加入框架型 Agent。

## 你可以做什么

- 创建用于代码、仓库工作、自动化和团队流程的云端 Agent。
- 把每个 Agent 的文件、聊天会话、终端状态和设置放在一起管理。
- 连接 Anthropic、OpenAI、Google Gemini 或 OpenRouter 等模型提供方。
- 安装 skills，让 Agent 按可复用流程工作。
- 通过网页工作区、`mf` CLI、Slack、Lark、飞书、Telegram、Discord 或 Matrix 访问同一个 Agent。
- 在产品界面查看会话、用量、渠道投递和运行状态。

## 第一次设置

1. 登录 Manyfold。
2. 在 **Settings -> Model providers** 添加模型提供方密钥，除非你的工作区已经有托管模型额度。
3. 从 **New agent** 创建第一个 Agent。
4. 选择 Agent 框架和运行模式。
5. 打开聊天工作区并发送第一个任务。

如果需要在终端中使用，请在登录后安装 CLI：

```sh
curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | sh
mf login
mf whoami
```

## 继续了解

- [安装 CLI](../install/)
- [创建第一个 Agent](../create-agent/)
- [连接模型提供方](../model-providers/)
- [使用工作区](../workspace/)
- [连接渠道](../channels/)
