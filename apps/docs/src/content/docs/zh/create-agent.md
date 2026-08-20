---
title: 创建第一个 Agent
description: 为新 Agent 选择框架、运行模式、模型提供方和工作区。
order: 3
---

# 创建第一个 Agent

一个 Agent 由托管工作区和 AI 运行环境组成。它会把聊天、文件、终端、模型设置和渠道连接放在同一个位置管理。

## 开始前

- 登录 Manyfold。
- 在 [模型提供方](../model-providers/) 中添加模型提供方，或确认你的工作区已有托管模型额度。
- 想清楚这个 Agent 要处理哪类工作。

## 选择框架

按任务选择合适的框架：

| 框架 | 适合场景 |
| --- | --- |
| Claude Code | 仓库工作、实现任务、终端工作流和长时间 coding session。 |
| Codex | 代码库修改、代码审查和需要工作区上下文的开发任务。 |
| Gemini CLI | 基于 Google Gemini 的编码和通用终端自动化。 |
| Hermes Agent | 连接器密集型工作流和后台任务。 |
| OpenClaw | 需要服务、gateway 或定时任务的工具型 Agent 应用。 |
| NarraNexus | 叙事驱动的 Agent 工作区，模型提供方和聊天由 NarraNexus 原生 UI 管理。 |

## 选择运行位置

大多数用户应该先选择 **Stateful sandbox**。它会为 Agent 提供隔离的云端工作区，并在暂停和恢复时保留文件与会话状态。

当 Agent 需要常驻进程、连接器、服务或定时工作流时，选择 **Cloud computer**。先在 **Settings -> Plan & billing -> Buy container** 租用 cloud computer，再回到 **New agent** 里把 Agent 挂上去。

当你希望 Manyfold 把工作路由到自己的机器时，选择 **Self-owned computer**。Self-owned computer 通过 **Settings -> Self-owned computers** 的本地 daemon 流程注册。

## 创建 Agent

1. 打开 **New agent**。
2. 选择框架。
3. 选择 Agent 的运行位置。如果使用 cloud computer，选择一个已经租用的现有 computer。
4. 选择或添加该框架需要的模型提供方密钥。
5. 如果页面展示模型设置，检查后继续。
6. 创建 Agent。

创建完成后，Manyfold 会打开聊天工作区。如果创建失败，进度面板会显示哪一步需要处理。

## 第一个任务

先从小而明确的请求开始：

```text
Inspect this repository and summarize the main app structure.
```

如果是编码任务，可以先让 Agent 解释计划，再开始修改：

```text
Review the authentication flow and propose the smallest safe fix for the failing login test.
```

## 接下来会发生什么

- 聊天线程会成为 Agent 的工作会话。
- 文件和终端访问会附着在同一个工作区。
- 你可以关闭浏览器，之后再回来继续。
- Agent 在网页工作区表现稳定后，可以把它接入团队渠道。

## 删除或替换 Agent

打开 **Settings -> Agents**，选择 Agent，并使用对应的运行环境或 Agent 控制项。删除 Agent 会停止它的新工作；对于不能丢失的文件，请保留自己的备份。
