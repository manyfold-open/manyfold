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

Live resource updates currently cover automations. Other resource pages
retain their existing refresh behavior; an older deployment may require
an explicit refresh even for automations.
