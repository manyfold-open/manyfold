---
title: 启动 Cloudflare 应用
description: 这个 launch flow 同时建立应用与开发 Agent：应用部署到 Cloudflare，Agent 连接 GitHub 代码库，在清晰的权限边界内持续修改、提交和推进工作。
order: 15
---
[cloudflare-worker-launch](https://github.com/manyfold-open/cloudflare-worker-launch) 是一条引导式启动流程：部署 Cloudflare 应用、授权 Manyfold、创建或采用 Agent、连接 GitHub 仓库，并检查应用和 Agent 是否准备就绪。目标不是只部署一次，而是建立可持续开发的工作链路。

应用与 Agent 保持不同职责：Cloudflare 承载应用；Manyfold 管理 Agent。GitHub 是两者之间的代码协作桥梁。

## 开始前准备

- **Cloudflare 持续开发流程**：一个 Cloudflare 项目、要连接的 GitHub 仓库、Manyfold 账户，以及按最小权限准备的部署凭据。
- **可轮换的凭据**：Cloudflare、GitHub 与 Manyfold 的凭据都要能被撤销和重新签发，且各自只授予这套流程需要的范围。

## 五步启动流程

| 步骤 | 动作 | 说明 |
| ---- | ---- | ---- |
| **第 1 步** | Deploy app | 从 launch 项目部署应用。此应用承载之后的配置与连接流程。 |
| **第 2 步** | Authorize Manyfold | 授权你的 Manyfold 账户，让启动流程可以为当前工作建立所需的 Agent 连接信息。 |
| **第 3 步** | 设置或采用 Agent | 创建新的 Agent，或采用已有 Agent；在此配置模型、开发技能、A2A 与所需的 Agent 凭据。 |
| **第 4 步** | Link GitHub | 连接应用对应的 GitHub 仓库，使 Agent 能在确定的代码库中工作并将变更提交回 Git。 |
| **第 5 步** | Readiness check | 确认应用、仓库和 Agent 的连接状态，再开始真实的开发任务。 |

启动流程可以选择新建或采用现有 Agent；这让团队能保留既有 Agent 的 workspace 与配置，而不是强制重新开始。

## Agent 之后如何持续开发应用

完成连接后，Agent 的典型循环是：理解任务 → 在连接的仓库中检查代码 → 修改文件 → 执行项目可用的验证 → 提交并推送变更。Cloudflare 的 Git 部署再根据你的项目设置构建和发布这些变更。

| 触发 | 结果 |
| ---- | ---- |
| **团队提出需求**，在 Manyfold 中向 Agent 说明任务 | **Agent 修改 GitHub 仓库**，提交并推送经过检查的变更 |
| **GitHub 变更**触发已配置的部署流程 | **Cloudflare 应用更新**，按项目的分支与环境策略发布 |

这不是绕过 Git 的直接生产修改。把代码变更留在仓库和现有 CI/CD 流程中，团队仍可使用分支保护、审查、预览环境和发布控制。

## 凭据与安全边界

launch 项目处理两类敏感信息：用于配置流程的管理 API token，以及供特定 Agent 会话使用的凭据。项目 README 说明这些信息由服务端保存，并建议生产多租户部署设置 `CONFIG_ENCRYPTION_KEY`。

```sh
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

| 凭据或权限 | 应如何处理 |
| ---------- | ---------- |
| Cloudflare 管理权限 | 只授予部署和配置所需的最小范围；完成 setup 后按团队策略保留或移除。 |
| GitHub 仓库权限 | 只连接 Agent 实际需要维护的仓库和组织范围，并保留审查与分支保护。 |
| Manyfold Agent 凭据 | 绑定明确的 Agent 和用途；避免共享高权限 token。 |
| 配置加密密钥 | 只保存为 Cloudflare secret；不得放到 Git、客户端、文档或截图中。 |

> **Agent 可以执行代码工作，不等于它应拥有无限权限**。把仓库权限、部署凭据和生产环境访问作为独立决定，并按照你的团队政策设置。

## 开始前检查

- 确认团队拥有 Cloudflare 项目与对应的部署权限。
- 确认要连接的 GitHub 仓库、默认分支、审查规则与部署策略。
- 决定采用已有 Agent 还是新建 Agent，并检查其运行环境、模型与技能设置。
- 准备只授予必要范围的凭据，并建立密钥轮换与撤销方式。
- 先用 staging 或非生产仓库运行一次完整流程，再接触生产用户和数据。

## 常见问题

- **这个 launch flow 做什么？**

  它通过部署、授权、Agent 设置、GitHub 连接和就绪检查，建立 Cloudflare 应用与可持续开发该代码库的 Manyfold Agent。
- **Agent 会自动获得生产环境的所有权限吗？**

  不应如此假设。应按最小权限原则配置 GitHub、Cloudflare 和 Manyfold 凭据，并由团队决定 Agent 可访问的仓库、环境和部署流程。
- **这个项目已适合直接用于生产吗？**

  README 标注为 Draft；生产使用前应先自行验证，尤其是 GitHub App 安装与新仓库的完整流程。

## 另请参阅

- [Worker starter 部署篇](/zh/docs/deployment/cloudflare-worker/)
- [Manyfold Agent API](/zh/docs/api-chat/)
- [Manyfold open source：cloudflare-worker-launch](https://github.com/manyfold-open/cloudflare-worker-launch)
- [Manyfold open source：Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter)
- [Cloudflare Workers 官方文档](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers CI/CD 官方文档](https://developers.cloudflare.com/workers/ci-cd/)
