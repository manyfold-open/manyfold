---
title: 设计 Multi-Agent 工作流
description: 让一个 Agent 负责规划和整合，再将研究、实现、审查等边界清晰的工作委派给专门的 peer Agents。
order: 12
---
**每个 Manyfold Agent 都有独立 workspace**。要建立 Multi-Agent 流程，请指定一个 Orchestrator Agent 负责拆解和整合，使用 A2A 将有限、明确的子任务交给被授权的 peer Agents，并通过 Git、附件或明确的共享存储交接工作成果。

A2A 提供的是受授权、可追踪的任务调用，不是无边界的 Agent 群聊。

只有目标 Agent 开启 A2A exposure，且允许调用方成为 peer caller 后，调用方才能发起工作。不存在「同一个团队中的所有 Agent 自动互相可叫」的预设关系。

## 开始前准备

- **A2A Multi-Agent 工作流**：至少两个已创建的 Manyfold Agent、清晰的角色边界，以及目标 Agent 的 peer 授权。
- **交接结果的落点**：一个 Git remote、共享仓库，或明确的文件输入 —— peer Agent 读不到另一个 Agent 的 workspace。

## 独立 workspace，不是自动共享文件夹

Manyfold 的每个 Agent 都有自己的 chat sessions、files、terminal access、skills 和 settings。一个 Agent 在自己的 workspace 写出的文件，不会自动出现在另一个 Agent 的 workspace。

| 需要交接的内容 | 推荐方式 |
| -------------- | -------- |
| 研究发现、验收条件、风险 | A2A 回传结构化 brief，或附上明确的输入文件。 |
| 代码变更 | Git branch、commit 或 pull request；不要依赖聊天转述。 |
| 较大的文档或资料 | 版本化仓库、受控共享存储，或使用 `--input-file` 传递需要处理的文件。 |
| 后续追问 | 复用该 A2A 任务的 `contextId`，只延续必要上下文。 |

## 推荐的角色设计：一个主控，多个专长 Agent

| 层级 | Agent | 职责 |
| ---- | ----- | ---- |
| **主控层** | Orchestrator Agent | 澄清目标、拆分任务、选择可调用的 peer、检查结果并决定是否进入下一步。它应是最终对用户负责的单一入口。 |
| **专长层** | Research / Builder / Reviewer Agents | Researcher 只读研究；Builder 在限定仓库与分支修改；Reviewer 独立检查 diff、测试和规格。每个角色只接收可验证的范围。 |
| **交付层** | Git 与部署流程 | 代码通过 branch、PR、review 和 CI/CD 流转。部署权限应独立于一般研究或实现权限。 |

从 2–3 个角色开始。只有当单一 Agent 已经稳定、任务确实可拆分且结果可验收时，再增加更多 Agent。

## 配置一个 peer A2A 调用

例如让 `agt_orchestrator` 调用 `agt_researcher`：

1. 打开目标 Agent（Researcher）的 **A2A** tab，开启 exposure。
2. 在目标 Agent 的 caller 设置中，授权 Orchestrator 为 peer caller。
3. 在 Orchestrator 的 terminal 中查看可调用对象，再发送任务。

```sh
# 以目标 Agent 为对象：开启 A2A，并授权调用方
mf --agent-id agt_researcher a2a exposure enable
mf --agent-id agt_researcher a2a callers add \
  --caller-agent-id agt_orchestrator

# 在 Orchestrator 的 runtime / terminal 中：发现并调用 peer
mf a2a status
mf a2a send agt_researcher "Summarize today's open pull requests."
```

**Exposure 与 caller grant 是两层独立控制**。目标 Agent 未 exposure 时，A2A 调用会得到 `404`；没有对应 peer grant 时，则不能以该 Agent 身份调用。每个授权应只覆盖确实需要的目标 Agent。

## 如何写出可执行的委派任务

不要只说「帮我研究一下」。一条好的 A2A delegation 至少包含目标、范围、约束、交付物和停止条件：

```sh
mf a2a send agt_researcher \
  "目标：梳理 authentication flow。
   范围：只读检查 src/auth 和相关 tests；不要修改或 commit。
   交付：文件清单、资料流、三个风险、最小修正建议。
   停止条件：完成上述 brief 后停止。"
```

长任务可串流进度，或先非同步提交、再按 task ID 追踪：

```sh
mf a2a send agt_researcher "Run the full audit." --stream

mf a2a send agt_researcher "Run the full audit." --async --json
mf a2a tasks get agt_researcher aat_xxx --wait
```

网络中断后优先查询已有 task 或重新订阅，不要立刻重送同一 prompt，否则可能生成重复工作。需要追问同一个任务时，传入返回的 `contextId`。

## 从研究到实现：一个实际的交接范例

| 交出 | 接手 |
| ---- | ---- |
| **Researcher** 只读分析并回传 brief | **Orchestrator** 确认范围，提炼可执行任务 |
| **Orchestrator** 将验收条件与分支规则交给 Builder | **Builder** 修改、测试、commit 到独立 branch |
| **Reviewer** 独立审查 diff 与测试 | **Orchestrator** 汇总结果并请求人工批准或下一步 |

重点是每个 Agent 都有可检查的输入与输出。对于代码，真正的交接物应是 commit 或 PR，而不是「我已经改好了」这一句话。

## Multi-Agent 运行守则

- **单一责任人**：让 Orchestrator 对最终答复和下一步负责，避免多个 Agent 同时对同一目标做决定。
- **最小权限**：Researcher 与 Reviewer 默认只读；Builder 只写指定仓库／branch；部署权限单独授予。
- **避免循环**：限定 peer 的任务次数、预算与停止条件；不要让两个 Agent 无限制互相追问。
- **先检查再重试**：对长任务使用 task get、subscribe 或 cancel，避免重复调用。
- **保留人类关卡**：涉及生产部署、外部发送、删除数据或权限变更时，要求人工批准。

> **A2A 的 API 配额计入同一账户的 API 用量**。应在 Settings → Usage 观察 Agent 与 provider 的用量；任务异常或昂贵时先停止并检查模型、权限与委派设计。

## 常见问题

- **多个 Agent 会共享同一个 workspace 吗？**

  不会。每个 Agent 有自己的 sessions、files、terminal、skills 和 settings。通过 A2A、Git 或明确的共享存储交接，不要假设文件会自动共享。
- **如何让一个 Agent 调用另一个 Agent？**

  在目标 Agent 开启 A2A exposure，并授权调用 Agent 为 peer caller。调用 Agent 使用 `mf a2a status` 查看可调用 peer，再使用 `mf a2a send` 委派任务。
- **什么时候应该使用 A2A？**

  当一个 Agent 或外部系统需要以协议化、可授权、可追踪的方式调用另一个 Agent 时使用。若只是人工在不同 Agent chat 中分配小任务，未必需要 A2A。

**想看图文配置步骤**？阅读[配置 A2A 权限](/zh/docs/a2a/permissions/)。

**需要先决定每个 Agent 在哪里运行**？阅读 [Sandbox 与 Self-owned computer 选择指南](/zh/docs/choose-a-runtime/)，再分配云端或本机任务。

## 另请参阅

- [Manyfold：通过 A2A 调用 Agent](/zh/docs/api-a2a/)
- [Manyfold：使用 CLI 调用 peer Agents](/zh/docs/cli/a2a/)
- [mf a2a reference：callers、send 与 tasks](/zh/docs/cli/reference/a2a/)
- [mf CLI 指南](/zh/docs/cli/)
- [Runtime 选择指南](/zh/docs/choose-a-runtime/)
- [Manyfold：使用 workspace](/zh/docs/workspace/)
- [A2A Protocol](https://a2a-protocol.org/)
