---
title: Manyfold Automations 是什么？
description: 让 Agent 按照计划或工作流条件自动执行重复任务，把结果交付到 workspace、Channel 或其他团队入口。
order: 8
---
**Automation 是 Agent 的自动执行计划**。你预先定义 Agent、workspace、prompt、触发条件和输出位置，之后 Agent 可以按计划运行，不需要每次手动打开聊天窗口。

Automation 适合重复、可验证、可以明确停止条件的工作。生产环境仍然应保留成本、权限和人工复核边界。

## 适合哪些任务？

- **定期摘要**：每天或每周整理项目进度、issue、PR 或使用量。
- **代码与状态检查**：运行测试、检查日志、扫描待处理任务，并回传结果。
- **团队提醒**：将完成情况或异常交付到 Slack、Telegram、Discord 等 Channel。

## Automation、Agent 和 Channel 如何配合？

| 阶段 | 组件 | 负责什么 |
| ---- | ---- | -------- |
| **触发** | Automation | 决定 Agent 什么时候开始工作，例如定时计划或手动运行。 |
| **执行** | Agent + Workspace | 读取允许的文件和工具，执行 prompt，并生成可检查的结果。 |
| **交付** | Channel 或 workspace | 把报告、文件或状态发送到团队已经使用的入口。 |

简单理解：Automation 负责“什么时候做”，Agent 负责“做什么”，Channel 负责“结果送到哪里”。

**想开始创建 Automation**？阅读 [Automation UI 创建与管理指南](/zh/docs/automations/create/)；如果要把结果送到团队工具，再看[连接 Slack Channel](/zh/docs/channels/slack/)。

## 另请参阅

- [按 UI 创建和管理 Automation](/zh/docs/automations/create/)
- [先了解 mf CLI](/zh/docs/cli/)
- [把结果发送到 Slack](/zh/docs/channels/slack/)
- [把结果发送到 Telegram](/zh/docs/channels/telegram/)
- [查看 Automation CLI 官方文档](/zh/docs/cli/automations/)
- [Manyfold FAQ](/zh/docs/faq/)
