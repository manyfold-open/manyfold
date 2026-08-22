---
title: 自托管
description: 在自己的基础设施上运行完整的 Manyfold 栈——安装、升级、备份与运维契约。
order: 1
---

# 自托管 Manyfold

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

`MF_API_CRYPTO_KEY` 是长期加密主密钥,静态加密所有存储的凭据(provider
key、token、登录 provider 密钥)。丢了它这些行就再也解不开——请和数据库备
份放在一起保管。

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

所有持久数据都在 Postgres(`pgdata` 卷)。默认
`CHAT_UPLOAD_ALLOW_DISK=true` 时,聊天上传的临时字节也可能落在 API 容器磁
盘;配置 `CHAT_UPLOAD_S3_*` 系列变量可以把上传移到任意 S3 兼容存储(一旦运
行多个 API 容器则必须配置)。

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

## 升级与降级

升级 = 代码树前进并重建;新 API 启动前迁移自动应用:

```sh
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

降级就是恢复备份:迁移只进不退,回退意味着 checkout 旧代码**并**恢复升级
前的数据库 dump。

## 对外服务(localhost 之外)

浏览器从别处访问这套栈时,有两件事必须改:

- **烘焙 URL。** web 和 admin 的产物在构建期烘入 API 地址。把
  `MF_SELFHOST_API_URL`(以及其余 `MF_SELFHOST_*_URL`)设成浏览器实际使用
  的 URL,然后重建(`up -d --build`)。
- **CORS。** `CORS_ORIGIN` 未设置时 API 反射任意来源(localhost 下没问
  题)。对外暴露 API 时,把 `MF_SELFHOST_CORS_ORIGIN` 设为确切的 web +
  admin 来源,例如
  `https://app.example.com,https://admin.example.com`。

TLS 在你的反向代理终结,再转发到三个端口;API 需要 WebSocket 转发
(daemon 连接与终端走 WS)。

## 邮件(SMTP)

邮件是运行时配置而不是环境变量:管理后台 → Settings → Email provider 填
SMTP host、端口和 TLS 模式,所有发信功能(注册验证、邀请)都用它。没配
provider 时,需要邮件的功能会明确提示,而不是静默失败。

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

- **`mf daemon`(默认)**——安装 [CLI](../install/),然后在任意自有机器上
  `mf login --api-url https://<your-api>/api` + `mf setup`。见
  [本地 daemon](../local-daemons/)。
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
