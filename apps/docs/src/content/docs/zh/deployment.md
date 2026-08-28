---
title: Manyfold 与 Cloudflare
description: Manyfold 不取代 Cloudflare、Vercel 或其他部署平台。它管理 Agent；部署平台承载面向用户的应用。两者通过 API 连接，形成从 Agent 工作到生产应用的清晰边界。
order: 13
---
**Manyfold 是 Agent 平台；Cloudflare 和 Vercel 是应用部署平台**。Manyfold 让团队创建、运行和管理 Agent。Cloudflare 或 Vercel 则将网站、API 与后台能力部署给终端用户。部署后的应用可以在自己的服务器端调用 Manyfold Agent API。

因此，问题不是「使用 Manyfold 后为什么不能用 Vercel」，而是「应用部署在哪里，以及 Agent 如何安全地连接到这个应用」。Manyfold 不要求应用部署在某一家云服务上。

## 三者的职责不同，但可以组成同一条工作流

| 层级 | 组件 | 职责 |
| ---- | ---- | ---- |
| **Agent 层** | Manyfold | 承载和管理 Agent 的 workspace、session、模型设置、skills、channels 与运行状态，并提供与 Agent 对话的 API。 |
| **应用与基础设施层** | Cloudflare 或 Vercel | 托管面向用户的前端、后端 API、部署流程与运行时能力；应用在服务器端保管凭据并调用 Manyfold。 |
| **体验层** | 你的产品与用户 | 用户通过网站、产品界面或业务流程与应用交互；应用把合适的任务交给指定的 Manyfold Agent。 |

这是职责分层，不是绑定关系。应用层可以选择 Cloudflare、Vercel 或其他兼容的托管环境。

| 问题 | Manyfold | Cloudflare / Vercel |
| ---- | -------- | ------------------- |
| 谁运行和管理 Agent？ | Agent runtime、workspace、session、模型与协作设置。 | 不是主要职责。 |
| 谁部署公开网站和业务 API？ | 不是主要职责。 | 部署应用代码、提供运行环境与交付流程。 |
| 谁处理 Agent 调用？ | 提供面向指定 Agent 的 API。 | 应用后端安全保存令牌、调用 API，并把结果呈现给用户。 |
| 谁负责基础设施能力？ | Agent 运行与团队管理能力。 | 按所选平台提供计算、存储、日志、CI/CD 等能力。 |

## 为什么这里以 Cloudflare 作为示例？

Cloudflare Workers 是一个可部署全栈应用和 API 的 serverless 平台，并可连接 D1、R2、Queues、Workflows 等平台能力。Manyfold 提供的开源 [Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter) 已将「连接 Agent、发送对话、验证连接，再在其上构建应用」这条路径做成具体起点。

- **Worker starter**：适合想从带有 Manyfold Agent 连接能力的 Cloudflare 应用模板开始的团队。
- **Workers 与服务绑定**：应用可将公开请求、数据库、对象存储、异步任务及外部服务连接在同一部署架构中。
- **Manyfold 仍是 Agent 层**：Worker 承载你的产品；Manyfold 负责所连接 Agent 的运行与管理。

这表示 Cloudflare 是一条文档和模板已经准备好的实现路径，**并不表示它是使用 Manyfold 的唯一或强制路径**。

## Vercel 在这个架构中的位置

Vercel 同样可以部署 Web 应用和服务器端函数，也支持以 Git 为中心的 Preview 与 Production 部署流程。若你的项目已经部署在 Vercel，应用的服务器端仍可调用 Manyfold Agent API；不需要因为使用 Manyfold 而迁移平台。

> **不要把 API token 放进浏览器**。无论应用使用 Cloudflare、Vercel 还是其他平台，Manyfold API token 应只保存在服务器端的环境变量或密钥管理中。浏览器应只请求你的应用后端。

真正需要评估的是应用本身：现有团队的部署流程、框架、数据服务、运行时需求与运维约束。Manyfold 处于 Agent 层，能够与这些部署选择并存。

## 安全连接的最小架构

| 发起 | 到达 |
| ---- | ---- |
| **浏览器 / 客户端** 只调用你的应用 API | **Cloudflare、Vercel 或其他后端** 保管密钥并调用 Manyfold |
| **应用后端** 使用服务器端凭据 | **Manyfold Agent API** 把请求发送到指定 Agent |

Manyfold 的 Chat Completions API 使用 Agent ID 作为 `model` 值，而不是直接把供应商模型名称暴露给应用。对于公开产品，还应在你的应用层配置自己的身份验证、授权、速率限制和审计策略。

## 常见问题

- **使用 Manyfold 是否必须使用 Cloudflare？**

  不必须。Manyfold 提供 Agent API；任何能在服务器端安全保存凭据并发出 HTTPS 请求的应用后端都可以接入。
- **Manyfold 能部署我的网站吗？**

  Manyfold 的核心是 Agent 的运行、管理和协作。网站和业务 API 的部署应由 Cloudflare、Vercel 或你选择的其他应用基础设施负责。
- **已经使用 Vercel 的团队需要迁移到 Cloudflare 吗？**

  不需要。Vercel 应用也可从服务器端调用 Manyfold API。Cloudflare starter 是一个已提供的实现示例，而不是迁移要求。
- **为什么不能从前端直接调用 Manyfold？**

  直接调用会让 API token 暴露给访问者。应由你自己的后端保存凭据、执行访问控制，再把必要结果返回给前端。

## 另请参阅

- [Cloudflare Worker starter](/zh/docs/deployment/cloudflare-worker/)
- [Cloudflare 持续开发流程](/zh/docs/deployment/cloudflare-app/)
- [Manyfold Agent API](/zh/docs/api-chat/)
- [Manyfold open source：Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter)
- [Cloudflare Workers 官方文档](https://developers.cloudflare.com/workers/)
- [Vercel Functions 官方文档](https://vercel.com/docs/functions)
- [Vercel Git deployments 官方文档](https://vercel.com/docs/git)
