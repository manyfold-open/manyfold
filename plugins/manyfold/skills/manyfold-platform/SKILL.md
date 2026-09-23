---
name: manyfold-platform
description: Manage resources on the Manyfold platform with the mf CLI and show automation changes and run results in the Manyfold web workbench. Use for Manyfold accounts, agents, automations, channels, skills, files, and model configuration; not for developing the Manyfold source code.
---

# Manyfold platform

Use the local `mf` CLI as the operation interface. It uses the same API and
resource state as the Manyfold web workbench. No local daemon is needed just
to manage remote resources.

## Connect and select the target

- Check `mf version`, `mf ui resolve --help`, and `mf profile show --json`.
  If the CLI is missing, use the official installation instructions at
  https://manyfold.ai/cli/install.sh. Do not run `mf setup` unless the user
  also wants to register this computer as an execution host.
- Keep the selected profile explicit on subsequent commands:
  `mf --profile <profile> ...`. Honor an explicitly supplied API URL. A CLI
  release channel does not select the user's intended deployment.
- Check `mf --profile <profile> whoami --json`. For an external coding agent,
  authenticate with `mf --profile <profile> login` when needed. This launches
  the user's browser and waits for its loopback callback; keep the process
  alive until it completes. Browser-pane login is a separate session.
- If identity is `agent-runtime`, use its existing identity. Account-wide
  actions may need `--account` and `mf auth ensure --scopes <needed scopes>`;
  show its consent URL and retry only after approval. An external user's CLI
  login currently grants `api.full`; a profile is not a permission boundary.
- Read `mf agent list --json` and choose the agent from the user's intent.
  Use explicit `--agent-id` where required. Do not assume `MF_AGENT_ID`
  exists outside a managed runtime.

Never read credential files into model context or put tokens in commands,
links, chat, or logs. CLI commands read saved credentials themselves.

## Operate and show automations

Read `mf help automations --agent` and `mf automations <command> --help`
for the current arguments. Use `--json` for commands and parse their results.
Before modifying an existing automation, refresh it with `automations get`.
Creating a schedule, running it immediately, and delivering to an external
channel are distinct actions; perform only those authorized by the request.

1. Resolve `mf ui resolve automation --json` and open its `url` so the user
   can watch the list while work continues.
2. Create or update through `mf automations`. Capture the returned automation
   ID, then resolve `mf ui resolve automation <id> --json` for its detail page.
3. Open or reuse that URL in the host's browser pane. In Codex, discover its
   browser/open-panel tools; in Claude Code Desktop, discover the Browser
   tools. In CLI-only hosts, return a named link. Prefer one workbench tab.
4. The page receives resource events for changes and run status. Do not
   navigate or reload it after each command. If it stays stale, reread through
   CLI and check that the page has the same account and deployment.
5. When execution is requested, `mf automations run <id> --json` returns a
   run ID. It does not prove completion. Read `mf automations get <id> --json`
   with bounded check-backs and inspect that exact run until it succeeds or
   fails. A failure is a result to report, not permission to submit a new run.
6. Resolve `mf ui resolve automation <id> --run-id <run-id> --json` to open
   the result conversation. The resolver covers recent runs with a session;
   wait for session creation when the run has only just started.

Read back the changed fields and inspect the visible page before claiming
the change is displayed. Preserve any unsaved user edits. If browser access
is unavailable, report CLI verification and provide the resolved link
without claiming visual verification.

## Other resources

Use the corresponding `mf help <topic> --agent` and command help for
channels, files, skills, model-config, backups, usage, runtime, and A2A.
Keep raw JSON on stdout separate from progress and errors on stderr. Do not
blindly retry a create/run request after a network timeout: first inspect
whether the resource or run was created.

Live plugin handoff currently covers automations. Other pages have their
existing refresh behavior, and `mf ui resolve` supports only automation
links. The CLI does not expose every Web operation; in particular, agent
creation covers only the frameworks and runtime choices shown by its help.
