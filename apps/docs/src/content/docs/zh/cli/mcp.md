---
title: 用 CLI 管理 MCP server
description: 为 Agent 添加、安装和移除 MCP server，并与其机器保持同步。
order: 9.5
---
MCP server 为 Agent 提供工具：数据库、搜索引擎、issue tracker 等。Manyfold 把 Agent 的 server 保存在其 framework 读取的配置中，并写入 Agent 的机器。Claude Code、Codex 和 Gemini CLI 的 Agent 支持 MCP server；用 `--agent-id` 或 `MF_AGENT_ID` 选择 Agent。

## 查看 Agent 的 server

```sh
mf mcp list --agent-id agt_xxx
```

Server 按所在的配置分组。Claude Code 有两个：`user`（`~/.claude.json`，默认）和 `project`（工作区的 `.mcp.json`）；Codex 为 `global`（`~/.codex/config.toml`），Gemini CLI 为 `user`（`~/.gemini/settings.json`）。列表显示 server 的 header 和环境变量名称，但从不显示它们的值，并说明配置是否已写入机器。

## 添加 server

通过 HTTP 访问的 server 传 URL；以命令运行的 server 把命令放在 `--` 之后，与 `claude mcp add` 相同：

```sh
mf mcp add sentry https://mcp.sentry.dev/mcp \
  --header 'Authorization: Bearer <token>' --agent-id agt_xxx
mf mcp add pg --agent-id agt_xxx --env DATABASE_URL=<url> \
  -- npx -y @modelcontextprotocol/server-postgres
```

`--` 之后的内容都属于 server 的命令行，因此 mf 自己的选项要放在它之前。`--scope project` 会把 Claude Code 的 server 放进工作区的 `.mcp.json`。用 `mf mcp remove <name>` 移除。

每次修改都会立即写入机器。休眠中的 sandbox，或 daemon 未连接的电脑，会在下次连接时收到；`mf mcp push` 可随时重新写入。

## 从 catalog 或你的 library 安装

```sh
mf mcp catalog list --q github
mf mcp catalog get github
mf mcp install github --env GITHUB_TOKEN=<token> --agent-id agt_xxx
```

`install` 先从你的 MCP library 取 server，找不到再从平台 catalog 取。Catalog entry 常带占位值：用 `--env` 或 `--header` 填入。`--as` 可让 server 在 Agent 上使用另一个名称。

常用的 server 可以存进你的 library：

```sh
mf mcp library create pg --env DATABASE_URL=<url> \
  -- npx -y @modelcontextprotocol/server-postgres
mf mcp library list
mf mcp library delete pg --yes
```

删除 library 中的 server 不会影响已安装到 Agent 上的副本。

## 在机器上直接添加的 server

Manyfold 每次写入配置时都会替换这些文件中的 server。直接在机器上添加的 server（用 `claude mcp add`，或编辑 `.mcp.json`）会在下次写入时丢失，除非先读回 Manyfold：

```sh
mf mcp pull --agent-id agt_xxx
```

## 另请参阅

- [用 CLI 管理 Skill](/zh/docs/cli/skills/)
- [CLI 命令参考](/zh/docs/cli/reference/)
