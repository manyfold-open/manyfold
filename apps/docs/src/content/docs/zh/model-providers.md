---
title: 模型提供方
description: 连接 Anthropic、OpenAI、Google Gemini、OpenRouter 或托管模型额度。
order: 4
---
模型提供方让 Agent 可以访问所需模型。你可以保存一次提供方凭证，并在创建 Agent 时复用。

## 支持的提供方

| 提供方 | 常见用途 |
| --- | --- |
| Anthropic | Claude Code |
| OpenAI | Codex |
| Google Gemini | Gemini CLI |
| OpenRouter | 模型路由和兼容模型访问 |

你的工作区也可能有托管模型额度。如果有，创建流程会展示可用选项，而不要求你粘贴个人 API key。

## 使用自己的订阅

Claude Code、Codex 和 Gemini CLI 的 Agent 可以直接使用 CLI 自身的登录会话运行 —— 例如 Claude Pro/Max、ChatGPT 订阅或 Google 账号 —— 而不需要 API key。

1. 创建 Agent 时，在模型提供方区域选择**使用自己的订阅**。
2. 创建完成后，在聊天页打开该 Agent 的终端，并在终端里完成 CLI 的登录。
3. 在登录卡片上点击**刷新状态**。检测到登录后，Agent 即可开始对话。

登录凭据只保存在 Agent 所在的 sandbox 或电脑里；Manyfold 不会为该 Agent 保存任何 API key。在 sandbox 中，登录在暂停和恢复后仍然有效，直到 sandbox 被删除。共用同一个 sandbox 的同 framework Agent 也会共享这次登录。

## 添加提供方密钥

1. 打开 **Settings -> Model providers**。
2. 选择提供方。
3. 添加标签，例如 `personal` 或 `team`。
4. 粘贴 API key。
5. 除非你使用兼容的自定义 endpoint，否则让 **Base URL** 保持为空。
6. 测试连接。
7. 保存提供方。

[创建 Agent](/zh/docs/create-agent/) 时，从创建流程中选择已保存的提供方。

## 提供方标签

标签应该说明归属或预算边界：

- `personal`
- `engineering-team`
- `staging`
- `managed`

避免在标签中包含 secret、客户名称或一次性任务名称。

## 轮换密钥

如果密钥被吊销或替换：

1. 打开设置中的提供方记录。
2. 粘贴新密钥。
3. 测试连接。
4. 保存提供方。
5. 重试失败的 Agent 操作。

保存后，已有 Agent 会使用更新后的提供方连接。

## 排查问题

- **测试连接失败**：确认密钥属于所选提供方，并且有模型访问权限。
- **创建 Agent 时要求提供方**：为所选框架添加兼容的提供方。
- **模型列表为空**：检查账户账单、模型权限和自定义 Base URL。
- **费用不符合预期**：查看 **Settings -> Usage**，确认 Agent 使用的是预期的提供方和模型。

## 另请参阅

- [创建第一个 Agent](/zh/docs/create-agent/)
- [使用工作区](/zh/docs/workspace/)
- [常见问题](/zh/docs/faq/)
