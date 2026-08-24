---
title: 安装 CLI
description: 安装、登录、更新并验证 mf CLI。
order: 2
---

# 安装 CLI

`mf` CLI 以独立二进制形式分发，日常使用不需要安装 Node.js。Agent、runtime、channel、automation、文件、backup、skill、usage、A2A 和 daemon 能力见 [CLI 总览](../cli/)。

## macOS 和 Linux

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
```

这条命令会安装 `mf`、完成登录、注册当前机器并启动 daemon。如果只想安装 CLI，不运行设置流程，请省略 `-s -- setup`。

下载安装包前，安装器会检查目标安装目录里的 `mf`。如果它已经是所选版本，安装器会跳过下载，但仍会继续执行指定的 setup 命令。

安装器默认把 `mf` 放到 `~/.local/bin`。如果安装后 shell 找不到命令，把下面一行加入你的 shell profile：

```sh
export PATH="$HOME/.local/bin:$PATH"
```

你也可以指定安装目录：

```sh
curl -fsSL https://manyfold.ai/cli/install.sh | MF_INSTALL_DIR=/usr/local/bin sh
```

如果安装到 `/usr/local/bin` 这类系统目录，可能需要 `sudo`。

## Windows

从下面的手动下载路径下载 Windows zip，解压 `mf.exe`，并把它放到 `PATH` 中的某个目录。

## 手动下载

每个版本的文件都挂在对应的 GitHub release 上：

```text
https://github.com/manyfold-open/manyfold/releases/tag/cli-v<version>
```

各通道当前指向哪个版本，发布在 manifest 里：

```text
https://github.com/manyfold-open/manyfold/releases/download/cli-channels/stable.json
```

| 平台                | 文件                           |
| ------------------- | ------------------------------ |
| linux-x64           | `mf-<ver>-linux-x64.tar.gz`    |
| linux-arm64         | `mf-<ver>-linux-arm64.tar.gz`  |
| macos-x64 (Intel)   | `mf-<ver>-darwin-x64.tar.gz`   |
| macos-arm64 (Apple) | `mf-<ver>-darwin-arm64.tar.gz` |
| windows-x64         | `mf-<ver>-windows-x64.zip`     |

每个压缩包旁边都有对应的 `.sha256` 文件用于校验，上面那份 manifest 也记录了每个文件相同的校验和。

## 登录

```sh
mf login
mf whoami
mf profile show
```

`mf login` 会打开浏览器登录。如果你在远程服务器上，或者无法自动打开浏览器，可以运行：

```sh
mf login --no-launch-browser
```

CLI 会打印一个 URL 和一个 code，然后停在 `Paste auth code:` 提示符等待输入。在任意一台机器的浏览器里打开这个 URL（CLI 跑在远程主机时，用你自己的笔记本打开即可），核对 code 一致后点击授权，把页面显示的授权码粘回终端。会话有效期 15 分钟。

通过 SSH 初始化远程机器时，`mf setup` 支持同一个参数：

```sh
mf setup --no-launch-browser
```

Credential 和 daemon state 存放在当前选择的
[CLI profile](../profiles/) 中。如果同一台机器要连接多个 Manyfold 部署，请使用
`--profile <name>` 或 `MF_PROFILE`。

## 验证安装

```sh
mf --version
mf agent list
mf runtime list
mf update --check
```

使用 `mf --help` 查看顶层命令地图，使用 `mf <command> --help` 查看当前安装版本支持的准确参数。

## 更新

```sh
mf update --check
mf update
```

如果本地 daemon 正在运行，更新 CLI 后请重启它，让它使用新的二进制。

### 从 CLI 0.21 或更早版本升级

CLI 0.22 引入了当前 profile layout，并移除了旧 config 和 daemon fallback。升级后，
请在目标 profile 中重新运行 `mf login` 和 `mf daemon register`。
`~/.manyfold` 下已有的 workspace 和 host skill store 会保留。

## 下一步

- [了解 CLI](../cli/)
- [Profile 和环境](../profiles/)
- [用 mf 编写脚本](../scripting/)
- [注册自有计算机](../local-daemons/)
