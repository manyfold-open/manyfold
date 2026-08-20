---
title: GitHub
description: 在 GitHub issue 和 PR 里 @mention Manyfold Agent。
order: 17
---

# GitHub

当你希望 Agent 直接在提 issue 的地方回答问题时，可以连接 GitHub。每个 channel 对应一个专属 GitHub App，作为 Agent 的身份：在 issue 或 PR 评论里 @mention 它就能开始一轮对话，进展会以一条实时编辑的评论展示。

## 能力概览

| 能力                 | 支持情况                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Issue / PR mention   | 支持，在 issue 正文、issue 评论或 PR 会话评论里 `@your-app` 即开始一轮对话。                    |
| 标签委派             | 支持，给 issue 加上可配置的标签即可免 mention 委派。                                            |
| 追问                 | 支持，在同一 issue 里再次 mention 即继续同一会话。                                              |
| 实时进展             | 支持，工作评论会随进展被原地编辑（GitHub 原生 preview）。                                       |
| 确认回执             | 支持，触发评论上会出现 👀，结束时翻成 🚀 或 😕。                                                |
| 停止请求             | 支持，评论 `@your-app /stop` 取消正在运行的 turn。                                              |
| 访问控制             | 支持，默认按 author association（owner/member/collaborator）把关，另有 login 允许/操作员列表。 |
| 收发文件             | 不支持，评论只有文本。                                                                          |

## 前置条件

- 一个已存在的 Manyfold Agent。
- 在个人账号或组织下创建 GitHub App、并把它安装到目标仓库的权限。

## 接入步骤

1. 打开 **Settings → Channels → New channel**，选择 **GitHub**，挑选 Agent（可选填仓库过滤），保存 —— 此时不需要任何凭据。
2. 在 channel 页面填组织 login（个人账号留空），点 **Create GitHub App**。GitHub 会展示一个预填好的建 App 页面，确认即可；凭据由 GitHub 自动回传，channel 随之激活。
3. 点 **Install on repositories**，选择 Agent 要响应的仓库。

想手工建 App 也可以：勾选 `issues` 和 `issue_comment` webhook 事件、`Issues: Read and write` 与 `Pull requests: Read and write` 权限，把 channel 的 inbound URL 设为 webhook URL 并配置 webhook secret，然后在编辑对话框里粘贴 App ID、私钥和 webhook secret，执行 **Register app**。

## 使用

在 issue 正文、issue 评论或 PR 会话评论里 mention —— `@your-app 总结一下讨论`。Agent 会先回 👀，发一条工作评论并随进展编辑，最后落下回复。配置了委派标签的话，给 issue 加标签即可免 mention 触发。

Issue 的标题、正文和近期评论会作为上下文一并带上，即使只在讨论末尾被 mention，Agent 也能看到全貌。

要让 Agent clone、push 或开 PR，请给同一个 Agent 关联 [GitHub Connection](../../workspace/) —— channel 的 App 有意不带仓库内容权限。

## 设置

| 设置项                  | 效果                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Repositories            | 只响应这些 `owner/repo`。留空 = App 安装到的所有仓库。                                                               |
| Allowed GitHub logins   | 一旦设置，只有这些用户能驱动 Agent（跳过 association 把关）。                                                        |
| Allowed associations    | 没设 login 允许列表时按此把关，默认 `OWNER, MEMBER, COLLABORATOR`；加 `NONE` 可在公开仓库对所有人开放。              |
| Operator GitHub logins  | 谁能执行 `/model` 这类全局命令。留空 = 从 GitHub 禁用。                                                              |
| Delegation label        | 给 issue 加上此标签即委派给 Agent。                                                                                  |
| Progress mode           | Preview（实时编辑的评论）、Activity（preview + 工具活动行）或 Final only。                                           |
| Fresh final comment     | 最终回复作为新评论发出，而不是编辑 preview —— GitHub 只对新评论发通知，编辑永远不通知。                              |

## 排查

**Mention 没反应。** 确认 channel 是 Active、App 已安装到该仓库、仓库通过了 channel 的仓库过滤、评论者过了 association 把关（公开仓库的路人默认会被拒，deliveries 列表会显示 `association_not_allowed`）。

**App 不能设为 issue assignee。** GitHub 不支持把 App 身份设为 assignee，请改用委派标签。

**Watcher 收不到回答通知。** GitHub 对评论编辑不发通知，打开 **Fresh final comment** 让回复以新评论落地。

**代码块里的 mention 不触发。** 有意为之 —— 检测 mention 时会忽略代码围栏、行内代码和引用行（邮件回复）。

## 限制

- 评论只有文本，双向都不传文件。
- 尚不处理 PR diff 上的 review 评论；PR 会话页可用。
- channel 的 App 无代码权限：仓库写操作始终来自 GitHub Connection。
