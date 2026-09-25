---
title: 自托管
description: 在自己的基础设施上运行完整的 Manyfold 栈——安装、升级、备份与运维契约。
order: 1
---
开源版用一份 Docker Compose 文件跑起完整的栈——API、Web 工作台、管理后台。
执行环境由你自带:在自己的机器上跑 `mf daemon`、接入 Kubernetes 集群,或在
管理后台粘贴 sprites.dev 账号 token。

## 安装

```sh
git clone https://github.com/manyfold-open/manyfold.git
cd manyfold
cp .env.selfhost.example .env
# 在 .env 里填两个必填值:
#   MF_API_CRYPTO_KEY   — openssl rand -base64 32
#   MF_AUTH_SETUP_TOKEN — 首次 setup 用的一次性口令
docker compose -f docker-compose.selfhost.yml up -d --build
```

然后打开 `http://localhost:3001/setup`,输入 setup token,创建管理员账号并
选择登录方式;工作台在 `http://localhost:3002`。新账号落在预置的无限额
`self_hosted` 档位上。

> **警告：** `MF_API_CRYPTO_KEY` 是长期加密主密钥,静态加密所有存储的凭据(provider key、token、登录 provider 密钥)。丢了它这些行就再也解不开,请和数据库备份放在一起保管。

## 跑了什么

| 服务 | 镜像 | 职责 |
| --- | --- | --- |
| `postgres` | `postgres:16` | 唯一的数据存储(没有 Redis) |
| `api-migrate` | 由 `apps/api/Dockerfile` 构建 | 一次性:跑完数据库迁移即退出 |
| `api` | 与 `api-migrate` 同镜像 | NestJS API,`:2222`,路径前缀 `/api` |
| `web` | 由 `apps/web/Dockerfile` 构建 | 用户工作台,`:3002` |
| `admin` | 由 `apps/admin/Dockerfile` 构建 | 管理后台,`:3001` |

## 启动顺序与迁移

Compose 把契约写死了:`api-migrate` 先把迁移 journal 跑到完成,`api` 才启
动;`web`/`admin` 等 API 健康检查通过。迁移只进不退且幂等——重启栈不会重复
应用任何东西。你永远不需要手工执行 SQL。

## 健康检查

`GET /api/health` 返回 `{"status":"ok","db":"ok",...}`,compose 的健康检查
探测的就是它。你自己的监控指向同一个 URL 即可。

## 数据与卷

Postgres 使用 `pgdata` 卷。单节点默认将上传字节和 metadata 放在
`chat_uploads` 卷，挂载到 API 的 `/tmp/manyfold-chat-uploads`，重建或
升级容器后仍可读取。上传仍是临时数据，原有的一小时过期策略继续生效。
多个 API 容器必须配置 `CHAT_UPLOAD_S3_*` 使用共享存储。

## 备份与恢复

两样东西要一起备份:

```sh
docker compose -f docker-compose.selfhost.yml exec postgres \
    pg_dump -U postgres -Fc manyfold > manyfold-$(date +%Y%m%d).dump
```

1. Postgres dump;
2. 你的 `MF_API_CRYPTO_KEY`(没有 key 的 dump 里,凭据行是解不开的)。

恢复到新栈:先只启动 `postgres`,`pg_restore` 导入 dump,再用同一个
`MF_API_CRYPTO_KEY` 拉起其余服务。

需要保留仍在有效期内的上传时，在停止或替换旧容器前复制字节和 metadata：

```sh
docker compose -f docker-compose.selfhost.yml cp \
    api:/tmp/manyfold-chat-uploads ./chat-uploads-backup
```

新 API 启动并挂载上传卷后，恢复目录内容，包括 `.json` metadata 文件：

```sh
docker compose -f docker-compose.selfhost.yml cp \
    ./chat-uploads-backup/. api:/tmp/manyfold-chat-uploads
```

首次从只使用容器临时磁盘的旧版本升级，也要在重建旧 API 前完成这次复制。
普通 `docker compose down` 保留 named volumes；
`down --volumes` 会同时删除数据库和上传存储。

## 升级与降级

先升级 API，再升级 CLI、Web 或 Admin 客户端。已验证的服务端基线是 edition
v0.11.0（API 5.1.0）。当前客户端要求 canonical API 契约：`mf whoami` 只使用
`/api/auth/whoami`，不再回退到账户端点；结构化失败使用
`{ ok: false, error: { code, message, details? } }`。旧 flat error 字段不再作为错误
metadata 解析，缺少 whoami 端点仍以 404 失败。

升级 API 前,先把每台 daemon 更新到 CLI 4.6.1 或更新版本:更旧的 daemon 会被 API
拒绝注册、heartbeat 和连接。早于 API 4.0.0 的部署须先运行 API 4.0.0,完成套餐、
runtime identity、shell 和 skill 的迁移。
新版本不会在启动或日常 runtime 操作中执行这些一次性迁移。

Editions journal 拆分之前的数据库(包括 API 0.51.1)须先用原发行版完成 journal
转换,再进入 API 4.0.0 升级桥。该桥负责套餐修复,不会转换旧 journal。如果迁移
报告数据库早于拆分,应先停止升级,在备份副本上使用兼容的转换版本完成迁移。
不要通过重置数据库或手工把 migration 标为已应用来绕过检查。

把 `WEB_BASE_URL`、`NCA_WEB_URL` 改为 `MF_WEB_URL`,其余旧 `NCA_*` API 配置改用
对应的 `MF_*` 名称。移除 `A2A_TURN_TIMEOUT_MS` 前先在 Admin 保存 A2A timeout;
`OPENCLAW_FETCH_TIMEOUT_MS` 改用独立的 `OPENCLAW_HEADERS_TIMEOUT_MS` 和
`OPENCLAW_STREAM_IDLE_TIMEOUT_MS`。旧 API 配置仍非空时,启动会明确报错并仅列出 key 名。

升级 = 代码树前进并重建;新 API 启动前迁移自动应用:

```sh
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

降级就是恢复备份:迁移只进不退,回退意味着 checkout 旧代码**并**恢复升级
前的数据库 dump。

## 套餐与配额

一个账号的所有上限 —— 能开多少 agent、多少个 external API agent、并发沙箱、
存储、channel、automation —— 都来自 `users.plan_id` 指向的那一档套餐。compose
栈设置了 `MF_DEFAULT_PLAN_ID=self_hosted`,也就是种子里那个无限档,所以在这套栈
上创建的账号实际没有限制。

Settings → Usage 显示当前套餐、含用户额外额度的实际资源上限，以及当前用量，
不提供 checkout 或 billing 操作。旧的 Plan & Billing URL 会跳转到此摘要。

`MF_DEFAULT_PLAN_ID` **只在账号创建的那一刻生效**,别处都不生效。在部署设置它
之前就建好的账号 —— 早于无限档的旧版本,或者从没传过这个变量的自写
compose / Kubernetes 清单 —— 会落在云端的 `free` 档并一直留在那里。症状是一条
提到你从没选过的套餐的配额报错:

```
External API limit reached (3 for Free plan)
```

旧的一次性套餐修复通过 API 4.0.0 完成。后续版本保留已有套餐归属,不会在启动时
自动修改。调整现有账号请使用 admin 控制台用户详情页的 **Plan** 卡片。
直接查看当前归属:

```sh
docker compose -f docker-compose.selfhost.yml exec postgres \
  psql -U postgres -d manyfold -c \
  "select u.email, u.plan_id, p.max_agents_provisioned
     from users u join plans p on p.id = u.plan_id;"
```

想让新账号落在别的种子套餐(`free`、`hobby`、`plus`、`pro`),在 `.env` 里设置
`MF_SELFHOST_DEFAULT_PLAN_ID`。

## 对外服务(localhost 之外)

浏览器从别处访问这套栈时,有两件事必须改:

- **烘焙 URL。** web 和 admin 的产物在构建期烘入 API 地址。把
  `MF_SELFHOST_API_URL`(以及其余 `MF_SELFHOST_*_URL`)设成浏览器实际使用
  的 URL,然后重建(`up -d --build`)。
- **CORS。** compose 默认只允许配置的 Web 和 Admin URL；未配置时使用
  `http://localhost:3002,http://localhost:3001`。URL 只写 scheme、host 和
  port，不带路径或结尾斜线。需要额外来源时显式设置
  `MF_SELFHOST_CORS_ORIGIN`，例如
  `https://app.example.com,https://admin.example.com`。

TLS 在你的反向代理终结,再转发到三个端口;API 需要 WebSocket 转发
(daemon 连接与终端走 WS)。

## 邮件(SMTP)

邮件是运行时配置而不是环境变量:管理后台 → Settings → Email provider 填
SMTP host、端口和 TLS 模式,所有发信功能(注册验证、邀请)都用它。没配
provider 时,需要邮件的功能会明确提示,而不是静默失败。

两种 SMTP 模式都要求加密:implicit TLS(通常为 465 端口),或
STARTTLS(通常为 587 端口)。STARTTLS 不可用或升级失败时,不会发送密码
或邮件。密码保留首尾空白字符;密码框留空则保留已存凭据。

## 删除账号

删除是管理员专属操作:管理后台 → Users → 用户详情 → Danger zone。发起删除
即刻停用账号——所有会话吊销、全部登录方式封禁、automation 暂停、keep-alive
关闭——并给用户发一封写明最终删除日期的邮件。

硬删除在宽限期(默认 30 天,`MF_DELETION_GRACE_DAYS`)之后执行。宽限期内管
理员可以恢复账号:登录封禁解除,但 automation 保持暂停直到手动重开。「立即
执行」在二次确认后跳过剩余等待。

到期后,后台 sweep 先拆除该用户的运行时(sandbox VM 删除、Kubernetes
namespace 移除;daemon 机器是用户自己的——文件不动,只吊销 token)与
channel 平台侧注册,再删除用户行,所有用户名下的表随 `ON DELETE CASCADE`
一并清除。自托管跑的正是这条路径:纯 cascade 加登录闸口,没有任何计费钩
子。`user_deletions` 审计行(只存裸 user id,无 PII)在删除后幸存,作为持
久记录;sweep 失败会把错误记录在该行上并自动重试。

## 执行环境

Agent 跑在你接入的计算机上,三条路:

- **`mf daemon`(默认)**——安装 [CLI](/zh/docs/install/),然后在任意自有机器上
  `mf login --api-url https://<your-api>/api` + `mf setup`。完整流程见
  [自托管部署的 CLI 与 daemon](/zh/docs/self-hosting-cli/),注册细节见
  [本地 daemon](/zh/docs/local-daemons/)。
- **Kubernetes**——在 API env 里加 kubeconfig,运行需要 gateway/cronjob 能力
  的框架;集群内 exec gateway 用
  `apps/k8s-gateway/helm/manyfold-k8s-gateway` 的 Helm chart 部署(其
  README 覆盖 `MF_K8S_GATEWAY_URL` / `MF_K8S_GATEWAY_TOKEN` 的接线)。
- **sprites.dev**——管理后台 → Infrastructure → Stateful sandbox accounts:
  粘贴 sprites.dev 账号 token,把 coding agent 跑在租用的 VM 上;并发跟随账
  号的 vendor 限额。

## 密钥轮换

轮换 `MF_API_CRYPTO_KEY`:把旧 key 移到 `API_CRYPTO_KEY_V0`(仅解密),新
key 设为 `API_CRYPTO_KEY`。在没有任何存量行仍记录 key version 0 之前保留旧
key;仓库里的 `.env.example` 对非 compose 部署记录了同样的流程。

## 聊天 Runner 要求

Claude Code、Codex、Gemini CLI、OpenClaw、Hermes 聊天必须连接 mf daemon runner。旧 daemon 运行 `mf update` 后重启；Kubernetes runtime 更新镜像并保留 PVC。OpenClaw/Hermes 镜像同时运行 gateway 和 daemon。`PUBLIC_API_BASE_URL` 必须能从 runtime 访问。Runner 缺失或过旧时会明确报错，不再切换到直连执行。Dify、Langflow、A2A 仍使用外部 API。
