# mf mcp — agent guide

## Purpose

Manage an agent's MCP servers. Manyfold keeps them in each config scope of
the agent's framework, as that framework writes them, and writes them into
the machine's config files: Claude Code's `user` scope (`~/.claude.json`)
and `project` scope (`<workspace>/.mcp.json`), Gemini CLI's `user`
(`~/.gemini/settings.json`), Codex's `global` (`~/.codex/config.toml`).
Other frameworks take no MCP servers from Manyfold. `mf mcp catalog` lists
the servers the platform offers; `mf mcp library` keeps the user's own, to
install on any agent.

## Required scopes

{{CALLER_CONTEXT}}

- `list`, `add`, `remove`, `pull`, `push` act on one agent: `agents:edit`
  (`agents:read` for `list`); your own agent needs no grant.
- `catalog`, `library` and `install` (which looks in both) are user-only:
  agent-bound tokens are refused. Hand those back to the user.

## Common commands

```sh
mf mcp list --agent-id "$MF_AGENT_ID"
mf mcp add sentry https://mcp.sentry.dev/mcp --header 'Authorization: Bearer <token>'
mf mcp add pg --env DATABASE_URL=<url> -- npx -y @modelcontextprotocol/server-postgres
mf mcp add pg --scope project -- npx -y @modelcontextprotocol/server-postgres
mf mcp install github --env GITHUB_TOKEN=<token> --agent-id "$MF_AGENT_ID"
mf mcp remove pg --agent-id "$MF_AGENT_ID"
mf mcp pull --agent-id "$MF_AGENT_ID"
mf mcp push --agent-id "$MF_AGENT_ID"
mf mcp catalog list --q github
mf mcp catalog get github
mf mcp library list
mf mcp library create pg --env DATABASE_URL=<url> -- npx -y @modelcontextprotocol/server-postgres
mf mcp library update pg --env DATABASE_URL=<new-url>
mf mcp library delete pg --yes
```

- `add <name> <url>` adds a server reached over HTTP (`--header 'Name:
  value'`, repeatable); `add <name> -- <command> [args…]` one run as a
  command (`--env NAME=value`, repeatable). Everything after `--` is the
  server's command line, so mf's own options (`--agent-id`, `--scope`,
  `--json`) go before it.
- `--scope` picks the config scope; the default is the framework's first
  (`user` for Claude Code). A name is lowercase letters, digits, `-` and
  `_`; one a scope already has is refused (remove it first).
- `install <key>` copies a server from the user's library, else from the
  catalog; `--env` / `--header` fill in its values (catalog entries often
  hold placeholders), `--as` renames it.
- Each edit is saved in Manyfold and pushed to the machine at once. A
  machine that is not connected (a sleeping sandbox) gets it when its
  daemon next connects.
- A push replaces the servers in those files with Manyfold's. Servers
  added on the machine itself (`claude mcp add`, an edited `.mcp.json`)
  are lost at the next push unless `pull` reads them in first.
- `library delete` removes the definition only; agents it was installed on
  keep their copy.

## Output

- `list`: one line per scope (`<label>  <path>` and whether it is on the
  machine), then a table of its servers (`NAME TRANSPORT TARGET HEADERS
  ENV`): the URL or command, and the names of its headers / env (never
  their values; the full config is in `mf agent get <id> --json`). A
  server from the agent's Composio connection shows as managed.
- `catalog list`: a table, `ID NAME TRANSPORT DESCRIPTION`;
  `library list`: `KEY NAME TRANSPORT TARGET`.
- `add` / `install` / `remove`: `✓ <done> <name> in <scope> (<path>) of
  <agent>`, then on stderr where it was written, or why not yet.
- `pull`: `<scope>  imported|unchanged|skipped|error`; `push`: one line
  per scope.
- `--json` on every subcommand; values stay masked in `list --json`.

## Failure recovery

- "not authenticated" → `mf help auth --agent`.
{{AUTH_RECOVERY}}
- `<framework> agents take no MCP servers from Manyfold` → only Claude
  Code, Codex and Gemini CLI agents take them.
- `already has a server named <name>` → `mf mcp remove <name>` first, or
  pick another name (`install --as`).
- `does not parse` → the scope's config text is broken; fix it in the web
  app's MCP settings of the agent.
- `saved; not written to the machine` → the machine is offline or asleep;
  it gets the config when its daemon connects, or `mf mcp push` once it
  is up.
- `another configuration push is using the machine` → nothing to do: the
  save's own push follows that one.
