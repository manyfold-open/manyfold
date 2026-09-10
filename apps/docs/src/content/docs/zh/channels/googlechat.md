---
title: Google Chat
description: 把 Google Chat 应用连接到 Manyfold Agent。
order: 17
---

当你希望 Agent 可以在 Google Workspace 中被找到时，就连接 Google Chat，既支持与应用的私聊，也支持应用被添加进的空间。配置会在两边进行：先在 Google Cloud 控制台创建应用和凭据，再把 Manyfold 的入站 URL 粘贴回 Chat API 配置页面。

## 该频道支持什么

| 能力 | 支持情况 |
| ---- | -------- |
| 私聊 | 支持；每条消息都会转给 Agent。 |
| 空间和群组会话 | 支持；默认需要显式 @ 提及。 |
| 提及检测 | 支持；Chat 原生标记对自己的提及，无需名称匹配。 |
| 会话串 | 支持；每个会话串有独立会话，回复会嵌套在发起该串的消息下面。 |
| 斜杠命令 | 以文本形式支持；你在 Chat API 控制台配置的命令同样有效。 |
| 实时进度 | 可选；Chat 对每个空间每秒只允许一次写入，因此默认只发送最终回复。 |
| 输入指示 | 不支持；Chat 没有面向应用的输入状态 API。 |
| 表情回应确认 | 不支持；对消息添加表情回应需要用户授权，应用不具备该权限。 |
| 接收文件 | 支持直接上传到 Chat 的文件。Google Drive 附件会被跳过，因为读取它们需要应用不具备的 Drive 权限。 |
| 普通回复中的文件 | 不支持；上传文件需要用户授权，因此文件链接会留在文本中。 |
| 显式的 Agent 发送文件 | 不支持；Google Chat 上不支持 `mf channels send --file`。 |
| 历史回填 | 不支持；读取历史消息所需的权限需要 Workspace 管理员批准。 |

## 前置条件

- 一个已存在的 Manyfold Agent。
- 一个你有管理权限的 Google Cloud 项目。
- 在你的 Google Workspace 域中安装 Chat 应用的权限。

## 配置 Google Cloud

1. 打开 [Google Cloud 控制台](https://console.cloud.google.com/)，创建或选择一个项目。在项目选择器中记下它的**项目编号**，后面可能会用到。

   ![Google Cloud 控制台首页，显示项目编号与项目 ID](../../../../assets/docs/channels/googlechat-01-cloud-project-demo.webp)

2. 在左侧菜单打开 **APIs & Services → Library**（API 和服务 → 程式库），或者直接在顶端搜索框输入 `Google Chat API`。

   ![Google Cloud 左侧菜单展开 APIs & Services，其中 Library 高亮](../../../../assets/docs/channels/googlechat-02-apis-services-library.webp)

3. 在结果中选择 **Google Chat API**，然后为该项目启用它。

   ![Google Cloud API 程式库的搜索结果，Google Chat API 排在第一个](../../../../assets/docs/channels/googlechat-03-search-chat-api.webp)

   ![Google Chat API 的产品详情页与 Enable 按钮](../../../../assets/docs/channels/googlechat-04-enable-chat-api.webp)

4. 在左侧菜单进入 **IAM & Admin → Service Accounts**（IAM 和管理 → 服务账号），创建一个服务账号。它不需要任何项目角色；起作用的是应用自身的身份。

   ![Google Cloud 左侧菜单展开 IAM & Admin，其中 Service Accounts 高亮](../../../../assets/docs/channels/googlechat-05-iam-service-accounts.webp)

   ![创建服务账号的表单，已填入名称、ID 与说明](../../../../assets/docs/channels/googlechat-06-create-service-account.webp)

5. 打开新账号的 **Keys**（密钥）标签页，添加密钥并选择 **JSON**。该文件只会下载一次，请当作机密保管。

   ![创建私钥的对话框，密钥类型已选择 JSON](../../../../assets/docs/channels/googlechat-07-create-json-key.webp)

6. 回到 Chat API 页面并打开 **Configuration**（配置）标签页。在填写其他内容之前，先确认 **Build this Chat app as a Workspace add-on** 保持关闭。这是这个页面上最关键的设置：一旦打开，应用会改为以 Workspace 加载项的方式部署，Manyfold 的 HTTP 端点就永远不会被调用。

   ![Google Chat API 的 Configuration 标签页，Workspace add-on 复选框未勾选](../../../../assets/docs/channels/googlechat-08-configuration-workspace-addon.webp)

7. 填写应用名称、头像 URL 和说明。

   ![Application info 区块，已填入应用名称与说明](../../../../assets/docs/channels/googlechat-09-application-info-demo.webp)

8. 在 **Functionality**（功能）下，启用 **Join spaces and group conversations**（加入空间和群组会话）。私聊不需要单独设置，应用一存在就能收到。

   ![Functionality 区块，Join spaces and group conversations 已启用](../../../../assets/docs/channels/googlechat-10-functionality.webp)

9. 在 **Connection settings**（连接设置）下，选择 **HTTP endpoint URL**。URL 先留空，下一节中 Manyfold 会给你。

   ![Connection settings 区块，已选择 HTTP endpoint URL](../../../../assets/docs/channels/googlechat-11-connection-settings.webp)

10. 在 **Visibility**（可见性）下，把应用开放给你自己或你的域。

    ![Visibility 区块，应用已开放给指定的人员和群组](../../../../assets/docs/channels/googlechat-12-visibility-demo.webp)

## 在 Manyfold 中创建频道

1. 进入 **设置 → 频道**，创建一个 **Google Chat** 频道。
2. 粘贴下载的服务账号 JSON 密钥文件内容。

   ![Manyfold 创建 Google Chat 频道的表单，包含服务账号 JSON 密钥栏位](../../../../assets/docs/channels/googlechat-13-manyfold-new-channel-demo.webp)

3. 保存后打开该频道并运行**注册**。这会校验密钥、捕获身份验证受众并激活频道。
4. 复制该频道的**入站 Webhook URL**。

   ![Manyfold 的 Google Chat 频道页面，显示入站 Webhook URL 与 active 状态](../../../../assets/docs/channels/googlechat-14-manyfold-inbound-url-demo.webp)

5. 回到 Chat API 的 **Configuration** 标签页，把它粘贴到 **Connection settings → HTTP endpoint URL**，然后点击 **Save**。

   ![Chat API 的 Connection settings，HTTP endpoint URL 栏位已填入 Manyfold 的入站 URL](../../../../assets/docs/channels/googlechat-15-http-endpoint-url-demo.webp)

## 与应用对话

有两种方式可以找到这个应用。建议先用私聊：它不需要空间、也不需要 @ 提及，可以把频道本身和空间里的其他因素隔离开来。

**开启私聊。** 在 Google Chat 侧边栏的 **Direct messages**（私聊）旁边点 **+** 或 **Start a chat**，搜索你的应用名称，选择带有应用标记的那一项（不是空间）。然后直接发一句 `hi`。私聊里的每条消息都会转给 Agent，不需要 tag。

**或者把它加进空间。** 点最上面的空间名称展开菜单，进入 **Apps & integrations**（应用程序与整合），再用 **Find apps** 或 Apps 区的 **+**。搜索你的应用并添加。加完之后它才会出现在这个空间的提及清单里，`@你的应用名称` 也才能触达 Agent。

在频道上运行**测试**，进来的消息会立刻显示在频道页面上。

## 身份验证受众

Google 会对发给你的每个请求签名，Chat API 控制台中的**身份验证受众**设置决定该签名声明的内容。Manyfold 必须配置成同一个值，否则所有进入的消息都会被拒绝。

| 控制台设置 | Manyfold 需要什么 |
| ---------- | ----------------- |
| **HTTP 端点 URL**（默认） | 无需操作；注册会根据入站 URL 自动填写。 |
| **项目编号** | 把受众类型设为项目编号，并填入你的 Cloud 项目编号。 |

如果之后在控制台改了这个设置，也要同步修改频道。两边不一致的表现是所有消息都被忽略，并在频道页面出现被拒绝的投递记录。

## 回复与每个空间的写入上限

Google Chat 对**每个空间每秒只允许一次写入**，而且该配额与该空间中的其他所有 Chat 应用共享。编辑消息和发送消息一样计入该配额。

因此该频道的默认回复模式为**最终**：Agent 完成后只发送一次。实时进度依然可用（把回复模式设为**预览**，Agent 会在工作过程中编辑占位消息），但它会消耗该空间的写入配额，因此更适合私聊和不繁忙的空间。

较长的回复会被拆成多条消息，间隔约一秒发送，并保持在同一个会话串中。

## 会话串

无论是否有人回复，Google Chat 都会为空间中每条新的顶层消息创建一个会话串。Manyfold 的处理方式如下：

- 在**空间**中，当 Agent 要回答时，它会在 Chat 创建的那个会话串里回复，让提问和回答留在一起。每个会话串是一个独立会话。如果你的空间配置为不使用会话串，请关闭**在消息会话串中回复**。
- 在**私聊**中，回复保持在顶层。只有你主动开启会话串时，私聊才会产生独立会话。

## 访问控制

把**允许的空间 ID** 和**允许的用户 ID** 留空，则任何能接触到该应用的人都可以使用。用户可以用邮箱地址或 `users/{id}` 资源名列出。

**操作员用户 ID** 控制谁可以运行 `/model` 等全局命令。如果没有列出操作员，这些命令在 Google Chat 中将被禁用。

## 疑难排查

**所有消息都被忽略，频道显示被拒绝的投递。** 身份验证受众不匹配。请核对 Chat API 控制台的**身份验证受众**与频道的受众设置，并确认控制台中的入站 URL 与频道页面上的完全一致。

**完全收不到消息。** 确认应用的**连接设置**指向该频道的入站 URL，应用状态允许你的账号使用，并且应用已被添加到该空间。

**回复失败并提示权限错误。** 应用已被移出该空间，或服务账号密钥已被吊销。在频道上运行**测试**可以看出是哪一种。

**Agent 回复在空间里而不是会话串中。** 该空间配置为不使用会话串。请关闭**在消息会话串中回复**。
