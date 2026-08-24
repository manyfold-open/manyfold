---
title: "mf login"
description: "Authenticate this machine with Manyfold"
order: 3
---
**用法:** `mf login [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--api-url <url>` | API base URL |
| `--token <token>` | API token ("-" reads stdin; direct values may appear in shell history and process lists) |
| `--no-launch-browser` | print the auth URL instead of launching a browser |
| `--auth-code <code>` | auth code copied from the browser |
| `--poll` | use the legacy device-code grant flow (requires --scopes) |
| `--wait` | with --poll, wait for approval before exiting |
| `--resume` | complete a pending poll-mode login whose process exited before approval |
| `--scopes <list>` | legacy --poll grant scopes (e.g. channels:read,channels:edit) |
| `--for-agent <id>` | legacy --poll grant target (defaults to --agent-id / $MF_AGENT_ID) |
| `--limit-to-agent` | request that the user limit the token to a single agent (sets the consent-page toggle default) |
| `--json` | output the result as JSON (token is never echoed) |
| `-h, --help` | display help for command |
