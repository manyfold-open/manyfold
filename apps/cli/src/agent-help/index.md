# Manyfold CLI (`mf`) — agent guide

Operate Manyfold resources on the user's behalf through the `mf` CLI.
This guide works inside a Manyfold-managed runtime and in an external
coding agent. Identity and browser availability are separate capabilities.

## Establish identity and target

Check `mf version` and `mf whoami --json`. Honor the user's selected profile
and API URL throughout the task; `mf profile show --json` reports saved
configuration without exposing credentials. A profile name or CLI release
channel alone does not determine the deployment.

- **Managed runtime** (`kind: "agent-runtime"`): the platform injects
  `MF_API_TOKEN`, `MF_AGENT_ID`, and `MF_API_URL`. Use that identity and
  endpoint. Do not run `mf login` or switch to a personal profile to bypass
  its permissions. `MF_DEPLOY_ENV` may also identify the deployment.
- **External user session** (`human-session` or `human-api-token`): use the
  selected CLI profile. If authentication is missing, run
  `mf --profile <profile> login` and let the user finish the browser flow.
  Select a target from `mf agent list --json` and pass `--agent-id` when a
  command needs it; `MF_AGENT_ID` need not exist. Login currently grants
  `api.full`; a profile isolates configuration, not permissions.
- If a managed runtime's identity is missing or rejected, report the runtime
  authentication problem. Do not replace it with a user login. Use the
  command's structured error to distinguish missing authentication from a
  missing scope; status 401 alone does not establish which one failed.

When `mf` is absent outside Manyfold, use the official installer at
https://manyfold.ai/cli/install.sh. Resource management only needs the CLI;
`mf setup` also registers this computer as an execution host and is appropriate
only when requested. Read `mf help auth --agent` for login and scope details.

## Managed agent scope

An authenticated managed agent operates on its own resources by default.
For account-wide actions, add `--account`; the API checks the required grants
and same-account ownership. If a command reports a missing grant:

```sh
mf auth ensure --scopes channels:read,channels:edit
```

Request **only the scope you are missing** (existing permissions are
KEPT — approval appends). The CLI prints a consent URL — **post exactly
that URL to the user** and ask them to approve. Never paste any token in
chat. The command exits after printing the URL; once the user approves,
just retry — the platform reads the added scope live. Details:
`mf help auth --agent`.

Examples for a managed identity reaching beyond its own agent:

```sh
mf automations list --account                       # across ALL your agents
mf automations list --account --agent-id agt_other  # a specific other agent
mf agent list --account                             # every agent on the account
```

Targeting another agent without `--account` is rejected. These managed-agent
grant rules do not mean every external user command needs `--account`.
For an external API token with insufficient scopes, use an appropriately
authorized token/profile; `mf auth ensure` grants a managed agent's scopes.

## Topics

{{TOPIC_LIST}}

Add `--json` to any `mf help … --agent` call for a machine-readable
envelope (`topic`, `cliVersion`, `topics`, `content`). Most commands also
accept `--json`; with it, the result is raw JSON on stdout and a failure is
emitted as `{ "error": { "code", "status"?, "message", "hint"? } }` on
stderr (never the raw response body), so both success and failure stay
parseable. Exit codes are stable in every mode: 2 network failure, 3 auth
(401/403), 4 not found, 5 invalid usage or arguments (400/422), 1 anything
else. `mf <command> --help` shows human-readable flags.

## Execution and recovery

- Read the relevant topic and current command help before an unfamiliar
  operation. Do not assume every Web operation has a CLI equivalent.
- Refresh the targeted resource before editing. Distinguish request
  acceptance from completion and inspect the exact returned run/job ID.
- After a timeout, inspect whether a create or run request took effect before
  retrying it. A failed run is not permission to submit another one.
- An ownership rejection requires checking identity and target, not
  repeatedly requesting scopes. Unknown flags require current command help.
- Follow existing user authorization; creating a schedule, running it now,
  and sending its result to an external channel are distinct actions.

## Safety (always applies)

- Never print `~/.manyfold/profiles/<name>/config.json`, any file below a
  profile's `daemon/` directory, or any token value.
- Only share the consent URL with the user — the URL alone is safe.
- Request the minimum scopes the task needs.
- Full rules: `mf help safety --agent`
