---
title: 常见问题
description: 关于 Agent、运行模式、模型提供方、渠道和安全性的常见问题。
order: 30
---

# 常见问题

## Manyfold 只是一个聊天包装层吗？

不是。Manyfold 托管真实的 Agent 运行环境，并提供工作区文件、终端访问、可恢复会话、模型提供方设置、skills 和可选的渠道连接。

## 我应该先选择哪个 Agent？

仓库工作建议从 Claude Code 或 Codex 开始。如果你的工作流已经依赖 Gemini，可以选择 Gemini CLI。当你需要连接器、服务、定时任务或产品工作流时，可以使用 Hermes Agent 或 OpenClaw 这类框架型 Agent。

## 和 Agent 聊天时可以上传文件吗？

可以。在聊天输入框使用附件按钮，即可在消息中添加图片或文档，Agent 会连同你的文字一起接收这些文件。大多数 Agent 支持附件，包括 Claude Code、Codex、Gemini CLI、OpenClaw、Hermes 和 Dify。对于 Dify Agent，请确保所连接的 Dify 应用已开启文件上传，并允许你发送的文件类型。

## 我需要自带模型 key 吗？

你可以自带模型提供方 key。部分工作区也可能有托管模型额度。创建流程会展示当前账户可用的选项。

## Stateful sandbox 和 Cloud computer 有什么区别？

Stateful sandbox 适合交互式编码和任务工作。它可以暂停和恢复，并保留工作区状态。

Cloud computer 适合常驻任务，例如服务、连接器或定时工作流。先在 **Settings -> Plan & billing -> Buy container** 租用，再把 Agent 挂到这台 computer 上。

## 可以在自己的机器上运行 Agent 吗？

可以。进入 **Settings -> Self-owned computers** 生成 token，然后用 `mf` CLI 注册这台机器。注册后的机器会作为 self-owned computer 出现；当 Agent 需要访问本地文件、硬件或云端工作区无法访问的私有网络时，它很有用。

## 一个 Agent 可以连接多个渠道吗？

可以。每个外部 bot 或 app 创建一个渠道。请使用清晰标签，便于区分每个渠道服务的团队、房间或工作流。

## Secret 应该放在哪里？

模型 key 放在 **Settings -> Model providers**，渠道 token 放在 **Settings -> Channels**。不要把 secret 粘贴到聊天 prompt、文件、issue 描述或公开日志中。

## Agent 会犯错吗？

会。AI 生成的工作可能错误或不完整。依赖 Agent 输出前，请审查关键结果、检查代码修改并运行测试。

## 如何减少意外费用？

使用清晰 prompt，及时停止方向不对的运行，查看 **Settings -> Usage**，并确认 Agent 使用的是预期的提供方和模型。

## 如何获取支持？

你可以从 Manyfold 工作区联系支持，或发送邮件到 [customer-support@netmind.ai](mailto:customer-support@netmind.ai)。请提供 Agent 名称、大致时间和简短问题描述，不要包含 secret。
