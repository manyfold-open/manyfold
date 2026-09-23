# Show Manyfold resources

Read [web-routes.md](web-routes.md) to establish the Web origin for the CLI's
deployment and to construct resource links. Browser login is separate from
CLI authentication.

When browser controls exist, open or reuse a workbench tab for the target
resource. In Codex, use the host's available browser/open-panel tools; in
Claude Code Desktop, discover the Browser tools. In a terminal, remote
runtime, or chat without browser controls, provide a named resource link
and continue through the CLI. Never install a browser dependency merely to
finish a platform operation.

## Automation workflow

1. Read `mf help automations --agent` and the relevant command help.
   When the workbench is available, open the automations list before
   creating a resource so the user can watch progress.
2. Create or update with `mf automations`, recording the returned automation
   ID. Use the route reference for its detail page.
3. API resource events update the open list and detail page. Do not reload
   after each command or overwrite unsaved user input. If the page remains
   stale, verify the account and deployment and reread the resource via CLI.
4. When execution is authorized, reread the automation and retain its
   `agentId` with the ID returned by `mf automations run <id> --json`.
   Submission does not prove completion.
5. Read `mf automations get <id> --json` with bounded check-backs and follow
   that exact run to completion or failure. A failure is a result to report,
   not authorization to run again.
6. Use the matching run's non-null `chatSessionId` and the recorded agent
   ID to show its conversation. For historical runs without known agent
   ownership, follow the fallback in the route reference.

Read back the changed fields and verify the visible result before claiming
it is displayed. With no browser, report CLI verification and the link,
without claiming visual verification. With no known Web origin, complete
the authorized CLI operation and report the resource ID.

## Other resources

Use the resource's `mf` command help and the route table, retain the returned
IDs, and read back the changed fields. Open the relevant view before a write
when the user wants to watch it happen. Live invalidations also cover:

- Channels: create, update, rebind, delete, and connection status.
- Skills: install, enable/disable, uninstall, and background installation outcomes.
- Personal skill library: create, edit, import, and delete; the library list
  reflects those changes without replacing an open editor's draft.
- Connections: create, rename, revoke, and OAuth completion.
- Agents: create, rename/configure, and delete; settings refresh saved MCP,
  environment, and connection data while preserving open drafts.
- Model configuration: saved model selection and tuning in Agent settings.
- Files: API writes, uploads, moves, directory creation, and deletion refresh
  the open Files tree and preview. Direct filesystem writes inside a runtime
  are not watched by these API events.
- Backups: creation, completion/failure, deletion, and restore outcomes.

Events are account-scoped invalidation signals. They carry no resource
contents, credentials, or browser navigation instructions. The Web refetches
authorized data, coalesces bursts, and catches up on reconnect/focus with a
slow polling fallback. Older deployments and views outside this coverage
may still require an explicit refresh. Never claim visual verification
based only on an emitted event.
