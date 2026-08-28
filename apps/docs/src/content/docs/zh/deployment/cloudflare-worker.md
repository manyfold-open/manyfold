---
title: 部署 Cloudflare Worker
description: 这个流程部署的不是 Manyfold 本身，而是一个部署在 Cloudflare 的应用。该应用安全地连接 Manyfold Agent，并把 Agent 能力带入你的产品体验。
order: 14
---
从 [cloudflare-worker-starter](https://github.com/manyfold-open/cloudflare-worker-starter) 开始，可以部署一个 Cloudflare Worker 应用，随后在应用中授权并连接一个 Manyfold Agent。Agent 仍在 Manyfold 中运行；Worker 负责用户界面、应用 API 与数据存储。

部署完成后，请先设置访问保护与密钥，再让用户连接 Agent。不要把 Manyfold 或 Cloudflare 的机密放在前端 JavaScript 中。

## 开始前准备

- **Cloudflare Worker 部署**：Cloudflare 账户、一个 Manyfold Agent，以及 Git 或 Wrangler 基础。
- **存放 token 的地方**：Manyfold API token 和 Cloudflare 密钥必须放在 Worker secrets 里，不能进仓库，也不能进浏览器端代码。

## 这个 starter 已准备好的部分

- **Worker + Web UI**：一个可部署的应用基础，可作为 Agent 功能的产品界面。
- **设备授权流程**：通过用户确认的连接流程让应用取得 Agent 会话所需的授权，而不是把令牌交给浏览器。
- **D1 持久化**：模板配置了 Cloudflare D1，用于应用所需的数据与会话相关状态。

模板还演示了与 Agent 的流式对话、对话延续及文件相关交互。它应被视为应用起点；上线前仍须按你的用户与数据模型补齐身份验证、授权和审计。

## 部署流程

| 步骤 | 动作 | 说明 |
| ---- | ---- | ---- |
| **1. 选择起点** | 使用 Deploy to Cloudflare，或 fork 模板仓库 | 前者适合从 Cloudflare 控制台快速创建项目；后者适合希望先在自己的 Git 仓库中审阅和修改代码的团队。 |
| **2. 创建与连接数据** | 配置 D1 数据库 | 依照模板中的 `wrangler.jsonc` 配置创建 D1，并写入对应的数据库标识。不要将生产凭据提交到 Git。 |
| **3. 连接 Git 部署** | 让 Cloudflare 在推送时构建和部署 | 模板的 Git 部署路径使用 `npm run build` 构建、使用 `npx wrangler deploy` 发布。完成后，每次向已连接分支推送都可触发新的部署。 |
| **4. 设置生产密钥** | 在 Cloudflare 中保存，不写入源码 | 至少设置管理员访问保护；生产的多租户场景还应设置配置加密密钥。使用 Cloudflare 的 secret 管理，而不是在仓库或客户端保存这些值。 |

```sh
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

`CONFIG_ENCRYPTION_KEY` 用于加密应用保存的连接配置。执行命令时由终端交互输入值，不要把真实值贴进代码、文档、截图或聊天记录。

## 部署后：连接并验证一个 Manyfold Agent

1. 打开 Worker 的公开 URL，并先完成应用本身的管理员或访问保护设置。
2. 在应用中开始连接 Agent；按照页面提供的设备授权步骤登录并确认。
3. 选择或连接目标 Manyfold Agent。
4. 发送一条低风险测试消息，确认流式回复和会话延续正常。
5. 再开始将产品功能、用户身份和业务流程接到该对话界面。

> **公开 URL 不等于公开 Agent**。如果任何访问者都能打开应用并调用 Agent，可能产生未授权的用量和费用。请在上线前为应用加上自己的身份验证与权限控制。

## 将已有 Cloudflare Worker 接入 Manyfold

不必从 starter 开始。现有 Worker 也可在服务器端调用 Manyfold 的 OpenAI-compatible Chat Completions API。请求中的 `model` 是 Manyfold Agent ID（例如 `agt_...`），不是底层模型供应商名称。

```http
POST https://api.manyfold.ai/api/v1/chat/completions
Authorization: Bearer $MF_API_TOKEN
Content-Type: application/json

{
  "model": "agt_your_agent_id",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

将 `MF_API_TOKEN` 留在 Worker 的服务器端 secret 中，并为 API token 只授予所需的权限范围。由你的 Worker 根据已验证的用户、产品规则和速率限制决定何时发起调用。

## 上线前安全检查

| 检查项 | 原因 |
| ------ | ---- |
| 密钥只保存在 Cloudflare secret | 防止 API token、管理员密码或加密密钥泄漏到浏览器和 Git 历史。 |
| 应用有身份验证与授权 | 控制谁能使用 Agent、读取会话或触发费用。 |
| 测试最小权限的 API token | 降低单个凭据泄露时的影响范围。 |
| 记录并审查应用请求 | 帮助追踪异常流量、失败调用和使用成本。 |
| 先在非生产环境验证 | 在对外发布前验证部署、数据和授权行为。 |

## 常见问题

- **这个模板部署的是 Manyfold 本身吗？**

  不是。它部署的是一个 Cloudflare 应用，该应用可通过 API 连接到 Manyfold Agent。
- **部署后最先要做什么？**

  先设置访问保护和生产密钥，再通过设备授权流程连接 Agent；不要将令牌放入浏览器端代码。
- **可以接入已有 Worker 吗？**

  可以。将 Manyfold API token 作为服务器端 secret 保存，并由 Worker 向 Chat Completions API 发送指定 Agent ID 的请求。

## 另请参阅

- [Manyfold Agent API](/zh/docs/api-chat/)
- [先比较部署分工](/zh/docs/deployment/)
- [Manyfold open source：Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter)
- [Cloudflare Workers 官方文档](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers secrets 官方文档](https://developers.cloudflare.com/workers/configuration/secrets/)
