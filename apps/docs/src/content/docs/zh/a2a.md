---
title: Manyfold A2A 是什么？
description: 'A2A 是 Agent-to-Agent 的协作入口：让一个 Agent 在授权、范围和任务状态都清楚的前提下调用另一个 Agent。'
order: 10
---
**A2A 让一个 Agent 调用另一个 Agent**。调用前需要目标 Agent 开启 exposure，并允许调用方成为 peer caller；任务可以被发送、追踪和取消。

A2A 不是让所有 Agent 自动进入同一个群聊，也不是 workspace 文件夹共享协议。

## A2A 的协作模型

| 示例 | Agent | 负责什么 |
| ---- | ----- | -------- |
| **调用方** | Orchestrator Agent | 例如，Orchestrator Agent 可以拆分目标、选择 peer、发送有边界的任务，并检查返回结果。 |
| **被调用方** | Researcher / Builder / Reviewer | 例如，这些专长 Agent 可以在自己的 workspace 和权限范围内完成专门任务；实际角色可以按工作流替换。 |
| **交接** | Result、Git 或共享存储 | 例如，可以用结构化结果、commit、PR 或明确的文件交接后续工作。 |

每个 Agent 仍然保留独立的 sessions、files、terminal、skills 和 settings。A2A 只负责受控的任务调用与结果传递。

> **以上角色只是一个示例**。A2A 并不限定只能用于 Researcher、Builder 或 Reviewer；例如客服、资料整理、数据分析、内容生成、测试或运维等工作流，也可以按需设计不同的 Agent 分工。

## 什么时候使用 A2A？

- 例如，研究、实现和审查需要不同 Agent 分工时。
- 外部应用需要协议化地调用 Agent 时。
- 任务需要权限、状态和结果追踪时。
- 单一 Agent 的上下文或工具边界已经不够时。

上面的研究、实现和审查只是示例；实际可以按业务场景替换成其他角色，例如客服、资料整理、数据分析、内容生成、测试或运维。

如果只是人工在两个聊天窗口之间复制一小段内容，直接使用 Chat 或 API 通常更简单。

**想把 A2A 变成实际的多 Agent workflow**？阅读 [A2A Multi-Agent 实作指南](/zh/docs/a2a/workflows/)，了解角色分工、权限、任务交接与结果追踪。

## 另请参阅

- [阅读 A2A Multi-Agent 实作指南](/zh/docs/a2a/workflows/)
- [配置 A2A Agent 权限](/zh/docs/a2a/permissions/)
- [使用 mf CLI 调用 peer Agent](/zh/docs/cli/a2a/)
- [通过 A2A 调用 Agent](/zh/docs/api-a2a/)
