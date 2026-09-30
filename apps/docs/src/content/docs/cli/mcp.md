---
title: Manage MCP servers with the CLI
description: Add, install and remove an agent's MCP servers, and keep them in step with its machine.
order: 9.5
---
MCP servers give an agent tools: a database, a search engine, an issue
tracker. Manyfold keeps an agent's servers in the config its framework reads
and writes them onto the agent's machine. Claude Code, Codex and Gemini CLI
agents take MCP servers; select the agent with `--agent-id` or `MF_AGENT_ID`.

## See what an agent has

```sh
mf mcp list --agent-id agt_xxx
```

Servers are grouped by the config they live in. Claude Code has two: `user`
(`~/.claude.json`, the default) and `project` (the workspace's
`.mcp.json`); Codex has `global` (`~/.codex/config.toml`) and Gemini CLI
`user` (`~/.gemini/settings.json`). The list shows the names of a server's
headers and environment variables but never their values, and whether the
config has reached the machine.

## Add a server

A server reached over HTTP takes its URL; one the agent runs as a command
takes the command after `--`, as `claude mcp add` does:

```sh
mf mcp add sentry https://mcp.sentry.dev/mcp \
  --header 'Authorization: Bearer <token>' --agent-id agt_xxx
mf mcp add pg --agent-id agt_xxx --env DATABASE_URL=<url> \
  -- npx -y @modelcontextprotocol/server-postgres
```

Everything after `--` belongs to the server's command line, so mf's own
options go before it. `--scope project` puts a Claude Code server in the
workspace's `.mcp.json` instead. Remove one with `mf mcp remove <name>`.

Each change is written to the machine at once. A sandbox that is asleep, or
a computer whose daemon is not connected, gets it when it next connects;
`mf mcp push` writes it again on demand.

## Install from the catalog or your library

```sh
mf mcp catalog list --q github
mf mcp catalog get github
mf mcp install github --env GITHUB_TOKEN=<token> --agent-id agt_xxx
```

`install` takes a server from your MCP library, or else from the platform's
catalog. Catalog entries often carry placeholder values: fill them in with
`--env` or `--header`. `--as` gives the server another name on the agent.

Keep servers you reuse in your library:

```sh
mf mcp library create pg --env DATABASE_URL=<url> \
  -- npx -y @modelcontextprotocol/server-postgres
mf mcp library list
mf mcp library delete pg --yes
```

Deleting a library server leaves the copies installed on agents in place.

## Servers added on the machine

Manyfold's config replaces the servers in those files whenever it writes
them. A server added on the machine itself, with `claude mcp add` or by
editing `.mcp.json`, is lost at the next write unless you read it in first:

```sh
mf mcp pull --agent-id agt_xxx
```

## See also

- [Manage skills with the CLI](/docs/cli/skills/)
- [CLI command reference](/docs/cli/reference/)
