---
title: 自托管部署的 CLI 与 daemon
description: 让 mf CLI 指向你自己的 Manyfold 部署、把机器注册成运行环境，并保持两边版本同步。
order: 2
---

# 自托管部署的 CLI 与 daemon

`mf` 二进制和所有人用的是同一个，没有单独的自托管版本。区别只在于它指向哪里：
默认情况下它连的是托管 API `api.manyfold.ai`，所以自托管部署必须显式地说明一次。

这一点几乎就是本页的全部内容。注册机器、开机自启、框架检测等等，都与托管服务的
文档完全一致。

## 安装

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | sh
```

它只把 `mf` 装到 `~/.local/bin`，不做别的——不会登录，也不会访问任何 API。
Windows 安装、指定目录、锁定版本见[安装 CLI](../install/)。

安装脚本从 `manyfold-open/manyfold` 的公开 release 下载，也就是你的部署所构建的
同一份源码，因此无论运行它的机器能否访问你的 API，行为都一样。

## 让 CLI 指向你的部署

用 `--api-url` 登录一次：

```sh
mf login --api-url https://<your-api>/api
```

这个 URL 会在登录时固定进当前 profile，之后每一条命令——`mf agent list`、
`mf daemon register`，全部——都会沿用它，不需要重复传这个参数。确认：

```sh
mf whoami
mf profile show
```

`mf profile show` 会打印该 profile 解析出的 `apiUrl`。如果显示的是
`https://api.manyfold.ai/api (channel default; pinned at login)`，说明登录时没有
固定住你的 URL，CLI 现在指向的是托管服务。

**自托管环境下不要直接运行 `mf login`。** 既没有 `--api-url`、profile 里也没有
存过 URL 时，CLI 会回落到托管 API，把你登录到错误的地方。解析顺序是：命令上的
`--api-url` → profile 中存储的 URL → 内置默认值。

`MF_API_URL` 用环境变量做同样的事，适合写进 shell 配置或部署脚本：

```sh
export MF_API_URL=https://<your-api>/api
```

### 与托管账号分开

如果同一台机器上你也在用托管服务，给这个部署单独一个
[profile](../profiles/)，而不是覆盖默认的那个。profile 在第一次被命名时就存在：

```sh
mf --profile selfhost login --api-url https://<your-api>/api
mf --profile selfhost whoami
```

profile 隔离凭据、daemon 注册和 daemon 状态，两边不会互相干扰。设置
`MF_PROFILE=selfhost` 就不用每次都带这个参数。

## 把机器注册成运行环境

自托管部署自身不带任何执行环境，所以在你接入运行环境之前，agent 无处可跑。通常的
做法是 daemon：`mf` 在你自己的机器上后台运行，按需接收 agent 会话。

一条命令覆盖整个流程——登录、签发机器 token、注册、安装自启，并等待 daemon 报告
健康：

```sh
mf setup --api-url https://<your-api>/api
```

通过 SSH 操作时加上 `--no-launch-browser`，然后在任意另一台机器的浏览器里批准。

如果 token 由管理员签发给你，则走手动流程。在你部署的 web 应用里打开
**Settings → Self-owned computers** 签发 token，然后在目标机器上：

```sh
mf daemon register --token ldt_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

`mf daemon register` 会使用 profile 中已存的 API URL，所以先登录，它自己就不需要
再传 `--api-url`。在回答启动提示之前先看一眼它打印的 `apiUrl:` 那一行——那是发现
注册到了错误位置的最后机会。

[注册 Self-owned computer](../local-daemons/) 完整讲了验证、自启、框架检测和吊销，
这些在自托管下同样适用，无需改动。

## 更新

无论你登录的是哪个部署，`mf update` 都跟随公开的发布通道，因为 CLI 和部署各自独立
计版本：

```sh
mf update --check
mf update
```

自托管部署下 daemon 不会自我更新。只有当 daemon 的 API URL 是托管默认值时后台
自动更新才会开启，因此自定义 URL 会让它保持关闭——不会有人在你自己掌握兼容版本的
部署下悄悄替换掉二进制。需要时按机器显式开启：

```sh
MF_DAEMON_AUTO_UPDATE=1 mf daemon start
```

`mf daemon status` 会显示该机器上自动更新是否开启。

让 CLI 与部署的版本不要差太远。管理员可以设置最低 CLI 版本，而且新的 API 能力通常
需要认得它们的 CLI，所以升级整套栈和在 daemon 机器上跑 `mf update` 应该放在同一次
维护里做。

## 确认当前跑的是什么

```sh
mf version --verbose
```

会输出版本、更新通道、源码 commit、构建时间、平台目标、安装方式，以及当前生效的
profile 和配置目录——这是确认一台机器用的是不是你以为的那个二进制和那个部署的最快
办法。

```sh
mf profile show      # 该 profile 解析出的 apiUrl 与登录状态
mf profile list      # 本机所有 profile
mf daemon status     # 本地 daemon：是否运行、版本、自动更新
```

## 排查

**`mf whoami` 失败，或者账号看起来是空的。** 几乎总是 CLI 登录到了托管 API 而不是
你的部署。运行 `mf profile show`，如果 `apiUrl` 不是你的，带 `--api-url` 重新登录。

**`mf daemon register` 提示 daemon token 不存在。** token 是你的部署签发的，但 CLI
把它递到了别处——同样的原因、同样的修法。register 输出里的 `apiUrl:` 那一行会告诉你
它去了哪里。

**daemon 注册成功但面板显示离线。** API 需要 WebSocket 转发。只终止 TLS、不升级
连接的反向代理会让注册成功、随后阻断 daemon 的 socket；见[自托管](../self-hosting/)
中关于对外提供服务的一节。

**daemon 连上了但检测不到任何 coding agent。** 检测是在 daemon 的 `PATH` 上找
`claude`、`codex` 和 `gemini`，而由自启单元拉起的 daemon 不会继承交互式 shell 的
`PATH`。运行 `mf daemon doctor`，它会报告找到了什么、在哪里找的。
