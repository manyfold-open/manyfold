---
title: Linear
description: 把 Manyfold Agent 安装成 Linear 工作区成员。
order: 16
---

# Linear

当你希望 Agent 直接在需求跟踪的地方接活时，可以连接 Linear。Agent 会成为工作区成员，可以被 @mention，也可以把 issue 委派（delegate）给它；工作进展直接展示在 Linear 的 agent session 上，而不是堆在评论里。

Linear 的 agent API 处于 developer preview 阶段，Linear 侧的细节仍可能变化。

## 能力概览

| 能力                  | 支持情况                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Mention 与 issue 委派 | 支持，两者都会创建 agent session。委派时 Agent 成为 issue 的 delegate，assignee 仍然是人。 |
| 追问                  | 支持，在 session 中回复即可继续同一轮对话。                                                |
| 实时进展              | 支持，思考过程、工具调用和任务清单会在 Agent 工作过程中展示在 session 上。                 |
| 停止请求              | 支持，Linear 的 stop request 会取消正在运行的 turn，Agent 会回确认。                       |
| 回跳 Manyfold         | 支持，session 上带 Open 链接指向完整 transcript。                                          |
| 收发文件              | 不支持，agent activity 只有文本。                                                          |
| 用户 allowlist        | 支持，派发前校验 Linear user ID。                                                          |

## 前置条件

- 一个已存在的 Manyfold Agent。
- Linear 工作区的 admin 权限（安装 application 必需）。

## 创建 Linear application

1. 在 Linear 打开 **Settings → API → Applications** 新建 application。它的名称和图标就是 Agent 在 mention、筛选菜单里的样子，建议简短好认。
2. 打开 **Webhooks** 并勾选 **Agent session events** 分类。URL 先留空——它包含 Manyfold channel id，此时还不存在。
3. 如果希望由 Manyfold 自己铸取 access token，打开 **client credentials**；否则自行铸一个 app token，留到下面第 3 步用。
4. 复制 **client ID**、**client secret** 和 **webhook signing secret**。

## 在 Manyfold 中接入

1. 进入 **Settings → Channels → New channel**，选择 **Linear**。
2. 选好 Agent，填入 client ID、client secret 和 webhook signing secret。如果要用自己铸的 token，就把它填进 **Access token**（不填 client 对）——signing secret 仍然必填。
3. 可选：用 **Allowed Linear user IDs** 限制谁能驱动 Agent。留空表示工作区内任何人都可以 mention 它。
4. 保存。Manyfold 会校验凭据、记录 app 身份并激活 channel。
5. 复制 channel 的 **inbound URL**，回填到 Linear application 的 webhook URL。

## 使用

在 issue 或评论中 mention Agent，或把 issue 委派给它。Agent 会在几秒内确认收到，然后开始工作。session 上看到多少取决于 channel 的 **Progress** 设置：

- **Activity** — 思考过程、每次工具调用，以及作为 session plan 的任务清单。
- **Final only** — 只有最终结果。

在 session 菜单里发送 stop request 可以中断运行，Agent 会停下并回一条确认。

## 设置

| 设置项                            | 作用                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Allowed Linear user IDs           | 只有这些 Linear 用户能驱动 Agent——每条消息（包括已有 session 里的追问）都按其作者校验，留空表示工作区内所有人。由 Linear automation 创建的 session 始终允许。 |
| Progress                          | 如上，Activity 或 Final only。                                                                           |
| Send message context to the agent | 在每轮对话前置注入 issue 与发送者元信息。                                                                |

## 排查

**Agent 显示为 unresponsive。** Linear 要求十秒内出现第一条 activity。检查 Linear application 里的 webhook URL 是否与 channel 的 inbound URL 一致，以及 Agent session events 是否已勾选。

**Mention 之后没反应。** 确认 Manyfold 里 channel 状态是 Active、Agent 有该 issue 所属 team 的访问权限；如果配了 allowlist，确认 mention 的人在名单里。

**凭据突然失效。** 轮换 application 的 client secret 会使已有 app token 失效。在 Manyfold 重新填入凭据，并且必须同时重填 signing secret。

**任务清单没出现。** Linear 的 plan API 仍是预览版。若 Linear 拒绝该 plan，Manyfold 会保留 session 的其他进展和最终回复，只丢掉清单。

## 限制

- Agent activity 只有文本，因此不支持双向文件。
- 进展不是逐 token 流式的：Linear 没有消息编辑 API。
- 从 Linear 侧禁用 `/model` 这类 agent 级命令。
