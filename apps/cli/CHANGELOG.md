# @manyfold/cli

## 5.10.0

### Minor Changes

- [#649](https://github.com/manyfold-open/manyfold/pull/649) [`777b6dd`](https://github.com/manyfold-open/manyfold/commit/777b6ddfe70db4837c6c002c508587a73a7c0347) Thanks [@yingca1](https://github.com/yingca1)! - `mf daemon start` no longer refuses with "daemon already running" when the daemon's pid file is left over from before a restart and its number now belongs to another process, and `mf daemon stop` no longer signals that process. A pid file written before the process now holding its pid started is treated as stale. Before, a daemon killed without cleanup could leave a machine whose daemon never started again until the file was removed by hand.

## 5.9.0

### Minor Changes

- [#645](https://github.com/manyfold-open/manyfold/pull/645) [`5f15d84`](https://github.com/manyfold-open/manyfold/commit/5f15d84e87180879814ebe1dad22f838a2a2e3a7) Thanks [@yingca1](https://github.com/yingca1)! - `mf a2a send` follows a task the peer hands back `working` at its blocking limit, with `tasks get`, and prints the answer when it finishes, within the same `--timeout`. A stream that ends before its task prints the followed answer rather than the partial text. When the deadline passes first, it exits 1 with the task id and the `mf a2a tasks get … --wait` command that keeps following it. A task that ends `failed`, `canceled` or `rejected` now prints its reason and exits 1 for `send`, `tasks get --wait` and `tasks subscribe`; before, it exited 0 without saying why. `tasks get --wait` also stops at a task that needs input instead of waiting out the deadline.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - A `401` for a token of the wrong kind now says what it needs. Endpoints such as your computers and the version lists answer a scoped or agent token with "this endpoint requires api.full token"; the hint used to say "Run mf login to sign in again", which changes nothing for a valid token. It now says the call needs a login session (`mf login`) or a full-access token.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - `mf sandbox list` shows each sandbox's Manyfold CLI version, as `old → new` when an update is out, and when any sandbox is behind it points at `mf sandbox update` for one and `mf updates apply --kind cli` for all of them. Before, the table had no version at all, though `mf sandbox update` told you to check it there.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - `mf update` now reports failures the way every other command does, and takes `--json`. A network failure exits `2` instead of `1`, and names the host it could not reach. A bad `--channel`, or a `--to` that is not a version, exits `5` before anything is fetched. A `--to` release that does not exist says so and points at `mf updates versions cli`, instead of printing a 404 URL. `--json` gives `--check` and the install result as JSON, sends progress to stderr, and needs `--yes`. `--channel` is now remembered only after the release resolved and you did not cancel; before, it was saved even when the update then failed.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - New `mf updates apply` runs pending updates from the terminal: the ids you give, or every one `--kind` and `--where` select that can run from here, in the same order as the web's Update Center. It keeps to the API's five computer updates a minute, waits out a rate limit once, and reports each update as updated, pending (taken once the machine's sessions or current work finish) or failed, then `N updated · M pending · K failed`. It exits `1` when an update failed. `--to` picks the version for one update; `--json` needs `--yes` and never prompts.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - New `mf updates` lists what the web's Update Center lists: the mf CLI and herdr on your computers, sandboxes and cloud computers, each runtime's framework, the CLIs a sandbox ships, and your agents' skills. Each row shows where it is, the version it is on and the one it would go to, and whether it can run from here or needs a person (with the command to run) or a machine that is offline. `--kind` and `--where` narrow it; `--json` carries stable ids and lists any source that did not load. `mf updates versions` shows the versions there are to install: `cli` for the mf CLI, or a framework name, which also lists the ranges the platform refuses and why.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - Inside an agent runtime, `mf --account usage summary`, `timeseries`, `events` and `sessions` read the whole account, as `--account` says. Before, they kept the runtime's own agent (`$MF_AGENT_ID`) as a filter, so `--account` changed nothing. An `--agent-id` typed on the command line still filters.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - `mf usage` checks its options before it sends anything, and a bad one exits `5`. `--bucket` takes `hour` or `day`; before, `--bucket month` quietly gave days. `--limit` is a whole number from 1 to 200 for `events` and from 1 to 100 for `top-agents`; before, `--limit abc` returned an empty page, and a limit over the maximum was capped. `--from` and `--to` take a date or a date and time such as `2026-10-01` or `2026-10-01T09:00:00Z`, where a time without a zone is UTC; before, one the API could not read was dropped. `mf mcp catalog list` and `mf skills discover` take `--limit` 1 to 100 the same way.

- [#643](https://github.com/manyfold-open/manyfold/pull/643) [`5bebaee`](https://github.com/manyfold-open/manyfold/commit/5bebaee9a36bb4a1451c51cdf85f90c65d2b2a7f) Thanks [@yingca1](https://github.com/yingca1)! - `mf usage` prints tables. `summary` shows a totals line and a row per model, framework and runtime, `timeseries` a row per UTC day or hour, `events` a row per call with the cursor for the next page, and `sessions` and `top-agents` a row each. A cost the platform could not price shows as unknown, and an empty window is a note, not an empty array. `mf usage` on its own runs `summary`, and a mistyped subcommand such as `mf usage sumary` is refused instead of running it. The JSON is unchanged, but it is no longer the default: a script or agent that reads `mf usage` output must pass `--json`.

- [#642](https://github.com/manyfold-open/manyfold/pull/642) [`8acec81`](https://github.com/manyfold-open/manyfold/commit/8acec814f353cc04f04b63c5ae29e19dd79a8b42) Thanks [@yingca1](https://github.com/yingca1)! - A daemon update that waits for its sessions to finish is no longer dropped when applying it fails once. Before, a deferred update whose release manifest or download timed out was given up silently, and the CLI stayed on the old version. The daemon now tries again twice, 15 seconds apart, and keeps refusing new sessions until the update lands or the third try fails.

- [#642](https://github.com/manyfold-open/manyfold/pull/642) [`8acec81`](https://github.com/manyfold-open/manyfold/commit/8acec814f353cc04f04b63c5ae29e19dd79a8b42) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox CLI update that the sandbox defers until its current sessions finish now completes. Before, the sandbox could fall asleep with the update half done. The API keeps the sandbox awake until the new CLI reports, which takes at most about 12 minutes and counts as active time.

    While the update waits, the sandbox summary carries `cliUpdateDeferred` (`activeSessions`, `deadline`). The runtimes page and `mf sandbox update` say how many active sessions the update is waiting for, instead of reporting the old version as upgraded. The Update Center keeps the row waiting until the sandbox reports another CLI. Asking again while the daemon is applying the update now waits for the new CLI instead of answering 503.

## 5.8.0

### Minor Changes

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `mf a2a` failures now exit according to their kind and say what failed.

    - An A2A endpoint that does not resolve, or refuses the connection, exits `2`, and the error names the endpoint (`A2A endpoint host … could not be resolved`).
    - A peer this agent holds no grant for exits `4`, with a hint to run `mf a2a status`.
    - Adding a caller that already has an active grant suggests `--replace-existing`.
    - An `--input-file` that cannot be read is a usage error (exit `5`).
    - In the standalone `mf`, any network failure now exits `2` like it does in the source build. Bun reports a host that does not resolve, and a closed port, as `ConnectionRefused`, which used to exit `1`.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `mf a2a send --input-file` now reaches a Manyfold peer: the peer gets the file in its workspace and can read it. Before, the server dropped the file part and the peer answered from the prompt alone.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - When a Manyfold A2A server refuses a call and names the cause, `mf a2a` now reports that cause instead of `cli_error`. The error shows the code (for example `SANDBOX_CLI_TOO_OLD` for a peer sandbox whose CLI predates files, or `delegation_limit`), and the command prints the matching hint and exits with the code for that kind of failure.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `mf a2a send --stream` no longer hangs in the standalone `mf` binary. Before, the reply finished on the server within seconds, but the command printed nothing and never exited. A2A requests from the standalone binary now use Bun's own fetch. They are still pinned to the address the SSRF check approved, and the TLS certificate is still verified against the endpoint's host name. The source build was not affected.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `mf channels sessions switch` to a deleted session now fails and says how to start a new session in that scope (`mf channels sessions new <channelId> --scope-key <key>`). Before, it reported success and changed nothing.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `mf channels test` and `mf channels register` now exit `1` when the check fails (`ok: false`), as `mf doctor` and `mf model-providers test` already did. The JSON report still goes to stdout. A script running with `set -e` now stops at a failed channel check instead of carrying on.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - The remaining list commands also print an aligned table with a header row: `mf a2a callers list`, `mf a2a tasks list` (and the peers and in-flight calls in `mf a2a status`), `mf backups list`, `mf runtime agents list`, `mf skills installed`, `skills discover` and `skills repos list`, `mf mcp list`, `mcp catalog list` and `mcp library list`, and `mf profile list`. In `mf profile list` the daemon column reads `pid <n>`, `registered` or `none`. `--json` is unchanged.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - List commands print an aligned table with a header row: `mf channels list`, `mf channels sessions scopes` and `sessions list`, `mf agent list`, `mf runtime list`, `mf automations list`, `mf skills library list`, `mf sandbox list` and `mf model-providers list`. Before, each printed space-separated values with no header, so a label with spaces in it shifted every column after it. `sessions list` names each session's state (`active`, `inactive`, `archived`) instead of a glyph. Chinese and other wide text lines up too. `--json` is unchanged and remains the format for scripts.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - A plan limit or quota no longer tells you to check your token's scopes. `CHANNEL_LIMIT_REACHED` and the other limit and quota codes each get a hint with the numbers, `(2 of 2 on the Free plan)`, and what to free up, for example `mf channels delete <id>`. Any other `*_LIMIT_REACHED` / `*_QUOTA_REACHED` code gets a generic plan-limit hint. `--json` passes their `details` through. They still exit `3`, like every `403`.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `--help` marks the options a command cannot run without as `(required)`, on every command at every depth, so the flags you must pass are visible without a failed run. `mf channels create --config` is now optional and defaults to `{}`, which is enough for `fake` and for the providers whose settings all have defaults. Lark, Matrix and iMessage still say which settings they need.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - New `mf channels sessions get <channelId> <sessionId>` shows one channel session, archived ones included, as a table row followed by its chat session id. `--json` prints the session record. An unknown session exits `4`, like any other not-found error.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - `mf channels sessions new --help` and the agent guide no longer say that `new` archives the current session. It leaves that session inactive: it stays in `sessions list`, and `sessions switch` brings it back. Only `delete` archives. The `sessions delete` help now says that `--activate-fallback` activates a fallback only when the active session is the one deleted.

- [#638](https://github.com/manyfold-open/manyfold/pull/638) [`14c7ac9`](https://github.com/manyfold-open/manyfold/commit/14c7ac9801167071f8f5be9a2959fa3918675a9b) Thanks [@yingca1](https://github.com/yingca1)! - A mistake on the command line now exits `5` with `invalid_usage` wherever the command notices it, as the exit-code table already promised. That covers a missing or conflicting flag, `nothing to update`, a `--config` / `--credentials` / `--body` that is not a JSON object, a missing agent id, and the checks in `mf channels`, `skills`, `files`, `auth`, `a2a`, `backups`, `profile` and `sandbox` that exited `1` before. An `@file` that cannot be read now names its flag (`--config: cannot read ./x.json (ENOENT)`) instead of printing Node's raw error.

## 5.7.0

### Minor Changes

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - Creating an agent from the CLI now chooses its model and its sandbox the way the web app does:

    - `--model-provider managed | subscription | <provider id or name>` binds the agent to Manyfold managed models, to the user's own subscription (signed in on the sandbox afterwards; the output prints the sign-in command and the chat link), or to a saved provider. `--model` picks one of the provider's tested models and is checked before anything is created. It takes an alias such as `sonnet` (the family's newest tested model), the exact id an alias stands for (saved as the alias), or a name as people write it (`Sonnet 5`, `sonnet 4.5`) when that names exactly one model. A model the provider was not tested with is a usage error that lists what it can run, grouped by family.
    - `--sandbox <id|name>` adds the agent to a sandbox the account already has instead of creating one; where the framework already runs there, the agent uses its credentials. `mf sandbox list` and `mf sandbox delete` show and free sandboxes, `mf model-providers list [--framework]` shows which providers can serve a framework and with which models, and `mf model-providers test <provider>` tests a provider again so that models released since its last test can be picked. `mf sandbox list` shows why a sandbox failed.
    - Key flags take `-` to read the key from stdin.
    - Progress names each step and how long it took. A dropped connection is picked up again, and after Ctrl-C (exit 130) running the same command again attaches to the create instead of starting another.
    - Failures a script can act on come with a hint for what to do next and, in `--json` output, their `details` (for example `RUNTIME_LIMIT_REACHED` with the plan's limit). When a new sandbox cannot reach the API, the hint says so and names the address, instead of the generic "try again later".

    Breaking changes:

    - `mf agent create` no longer reads keys, base URLs or models from environment variables (`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `PI_API_KEY` and the like). Pass the key flag, with `-` to read it from stdin. A create that names no model source is a usage error (exit 5) listing the choices.
    - `--provider-id` is now `--runtime-provider`, and `--model` replaces `--gemini-model`, `--pi-model` and `--agy-model`.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `mf agent send <agent> "message"` talks to an agent from the terminal and prints its reply. It starts a session, or continues one with `--session <id>` or `-c` (the one last active), sends the message the way the web chat does, and follows the reply on the session's stream: streamed to stdout in a terminal, printed whole when piped, with tool calls and a footer (model, tokens, cost, time, and how to continue the session) on stderr. The message can come from stdin (`-`). `--file <path>` (repeatable) uploads a local file into the agent's workspace and attaches it, images included, within the chat limits (10 files, 25 MiB each, 100 MiB in all), checked before anything is sent. `--json` prints the turn as one object. `--show-thinking` (on `send` and `chat`) prints the agent's thinking, dim on stderr, as it streams, and adds it to `--json` as `thinking`. Ctrl-C stops the turn on the server and exits 130; a dropped stream is picked up where it left off. The agent's saved model and permission settings apply, and nothing is saved. A session open in a terminal (`session_held_by_terminal`) or still taking in what one wrote (`session_import_pending`) gets a hint that says what to do.

    `mf agent chat <agent>` holds the same conversation at a prompt in a terminal, one message per line: `/new` starts a new session, `/exit` or Ctrl-D leaves, Ctrl-C during a reply stops the turn. `--file` attaches files or images to the first message, as context for the chat.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `mf agent update --model` and `--clear-model` set a coding agent's model. Claude Code, Codex, Gemini CLI, pi and Antigravity CLI keep the model in the agent's model settings, so the CLI now sends it there, the same change `mf model-config update --model` makes, instead of failing with `Use /agents/<id>/model-config to update claude-code models`. The output adds a `model` line, with the id an alias stands for (`haiku (claude-haiku-4-5-20251001)`), and says that the model runs from the next turn of every session, sessions already open included.

    Both commands now take the model names `mf agent create --model` takes: an alias such as `haiku`, the id an alias stands for (saved as the alias, which the agent's settings list it by), or a name as people write it (`Haiku 4.5`). Where the settings list every model the agent can run (all but Gemini CLI and pi on a provider, whose providers may serve more), a model they do not offer is a usage error (exit 5) that lists the ones they do, before anything changes.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `mf automations run --wait` follows the run's reply as it streams, the way `mf agent send` shows a reply, then says how the run ended (`run aur_… succeeded`, or `failed:` and why) and whether it reached the automation's channel; a failed run exits 1, and Ctrl-C stops following without stopping the run. `mf automations result <id>` prints the full reply of the automation's latest run, or of `--run <runId>`, or why it failed, following a run still going to its end, where `get` only had the first line of each reply. Both take `--show-thinking` and `--json` (`{ run, text, usage, error }`). `run` without `--wait` says where to find the result.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `mf automations create` takes its schedule the way you would say it. `--schedule-preset daily` alone builds the rule, the same one the web's schedule picker builds, timed with `--at 17:30` (09:00 by default) and, for `weekly`, `--day fri`; an `--rrule` alone is a custom schedule; `--timezone` defaults to this machine's zone. Only `--title` and `--prompt` are required, where the preset, the RRULE and the timezone all had to be given and kept in step. `mf automations update --at 07:30` re-times the automation's own preset. `create` and `update` print the schedule and the next run on the automation's clock.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `mf mcp` manages an agent's MCP servers from the terminal, as the web app's MCP settings do. `mf mcp add <name> <url>` adds a server reached over HTTP (`--header` for its headers), and `mf mcp add <name> -- <command> [args…]` one run as a command (`--env` for its environment), as `claude mcp add` takes them; `--scope` picks the config it goes in (Claude Code's `user` or `project`, Codex's `global`, Gemini CLI's `user`). `mf mcp install <key>` copies a server from your MCP library or the platform's catalog, with `--env` / `--header` to fill in its values. `mf mcp list` shows each scope's servers (the names of their headers and env, never the values) and whether they reached the machine; `mf mcp remove` takes one out. Every change is written to the machine at once, and says so, or why not yet. `mf mcp pull` reads servers added on the machine itself into Manyfold before a push replaces them; `mf mcp push` writes them again. `mf mcp catalog list|get` browses the catalog, and `mf mcp library list|create|update|delete` manages your library. Arguments after `--` no longer switch mf's error output to JSON when one of them is `--json`.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `mf sandbox update <sandbox>` updates the Manyfold CLI on a sandbox, as the web's Update Center does: to its channel's latest, or `--to <version>` for a particular build (dev builds included, checked against the versions offered before anything is sent). It prints the version it went from and to, says when a busy sandbox will take the update, and when the sandbox already runs its channel's latest, lists the newer builds `--to` can install. A file operation that fails because a sandbox's CLI is too old (`SANDBOX_CLI_TOO_OLD`) now points at this command instead of "contact support".

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - `mf skills install` takes a skill's name: `mf skills install mcp-builder --agent-id agt_…` finds it in your library or the catalog (an exact match, ignoring case, by the skill's name or its folder's) and installs it, saying where it came from; `anthropics/mcp-builder` takes that repo owner's. A name several skills share (the catalog's repos overlap) lists them, by owner and by id, and installs none. Ids work as before, as the argument or as `--skill-id`. `mf skills discover` prints `(no skills found)` for an empty page, where it printed nothing, and names on stderr the repos the API is still reading for the first time. `mf skills list` (and `ls`) is `mf skills installed`.

- [#632](https://github.com/manyfold-open/manyfold/pull/632) [`f4d719b`](https://github.com/manyfold-open/manyfold/commit/f4d719b8b4c0c221eff34deb1a25a82e1c14caa0) Thanks [@yingca1](https://github.com/yingca1)! - A skill written on this machine goes into your library in one step. `mf skills library publish ./my-skill` packs the folder (its `SKILL.md` and the files next to it), creates the library skill, or updates the one of that name in place, and pushes it to the agents that have it installed. `mf skills library import --file` takes a folder too, where a folder crashed it with `EISDIR`, and says what it takes when given another kind of file. `mf skills library create` takes the skill's name from its SKILL.md frontmatter when `--name` is left out. A delete refused because agents have the skill names them and `--force`, and counts read `1 file, on 1 agent`, not `1 files, on 1 agent(s)`.

## 5.6.0

### Minor Changes

- [#620](https://github.com/manyfold-open/manyfold/pull/620) [`27b8ca8`](https://github.com/manyfold-open/manyfold/commit/27b8ca89fc1ab39d586b3a9be0254c6fcb23dbde) Thanks [@yingca1](https://github.com/yingca1)! - The built-in model catalog of Claude Code, Codex and Gemini CLI is one file, `packages/shared/src/framework-model-catalog.yaml`, and every release applies it right after the migrations (`node dist/db/migrate.js`, the self-hosted `api-migrate` service included). A row the file lists is set to what the file says, so admin edits to those rows last until the next release; a row an admin added is left alone. `node dist/db/framework-catalog.js import [--file <catalog.yaml>] [--dry-run]` applies a catalog on demand, and `export` writes the database's catalog as YAML (`just catalog-import`, `just catalog-export`).

    Codex agents can run GPT-6 Sol, with reasoning up to `ultra`, and GPT-6 Luna, up to `max`, both with the fast tier. A provider that serves GPT-6 Sol but not GPT-6 Astra defaults new agents to it. GPT-5.4, GPT-5.4 Mini and GPT-5.2 are retired, as they are in Codex itself: an agent set to one of them is asked to choose a supported model. The model the platform writes into a host's Codex config is GPT-5.6 Sol, which every channel serves and ChatGPT sign-in keeps (GPT-5.5 leaves Codex for ChatGPT sign-in on 2026-10-14); a host picks it up the next time its credentials are written. A Codex terminal that resumes a session on the platform provider runs the agent's model.

    Claude Code runtime-local model lists offer Opus 5, Opus 5.5, Sonnet 5.5 and Fable 5.1. Opus 5.5 and Sonnet 5.5 fall back to medium effort, as Claude Code starts them, and an explicitly chosen Fable model is labelled Fable in the composer.

## 5.5.0

### Minor Changes

- [#595](https://github.com/manyfold-open/manyfold/pull/595) [`5b8faf4`](https://github.com/manyfold-open/manyfold/commit/5b8faf4284a20c2e869af75df8b631271f04ada6) Thanks [@yingca1](https://github.com/yingca1)! - Add `mf login --print-auth-url`, a two-step sign-in for coding agents and other callers without an interactive terminal. It prints the sign-in URL and exits (`--json` adds the API URL, profile and the follow-up command); after the user approves, `mf login --auth-code <code>` completes it. Nothing is stored in between. `--no-launch-browser` without a terminal now points to this flow, and the agent guide allows the one-time `mf_auth_` code — never a token — to be passed on.

- [#596](https://github.com/manyfold-open/manyfold/pull/596) [`531abbb`](https://github.com/manyfold-open/manyfold/commit/531abbbc92c356c7640ae028b6c39d492a85be6c) Thanks [@yingca1](https://github.com/yingca1)! - A sandbox or cloud computer whose daemon has work in progress when it needs a newer Manyfold CLI now answers "updating once its current work finishes; retry in a few minutes" within seconds. Before, the caller waited three minutes and was told the daemon did not come back. The update is asked for once: a daemon that is draining for an update now keeps its first deadline, so asking again no longer puts the update off.

## 5.4.0

### Minor Changes

- [#590](https://github.com/manyfold-open/manyfold/pull/590) [`a007e4b`](https://github.com/manyfold-open/manyfold/commit/a007e4bfa0abb80c6341452115fea387f0bcf1e5) Thanks [@yingca1](https://github.com/yingca1)! - File operations and terminals on the daemon now accept the folders Manyfold vouches for, the way commands already do, so a hosted machine's files and shells are reachable without registering each folder first. No folder, vouched for or registered, reaches into the daemon's own settings folder, where its tokens and command records live, beyond its workspaces and sign-ins. A terminal whose folder is refused no longer keeps the sign-in it was about to use locked.

- [#590](https://github.com/manyfold-open/manyfold/pull/590) [`a007e4b`](https://github.com/manyfold-open/manyfold/commit/a007e4bfa0abb80c6341452115fea387f0bcf1e5) Thanks [@yingca1](https://github.com/yingca1)! - The daemon takes a file larger than one message in parts: each part is appended in order to a private file next to the destination, and the file replaces the destination only once it is complete and its size and checksum match. An interrupted upload never leaves a half-written file behind, and the parts of an upload nobody finishes are cleaned up within two hours or when the daemon restarts.

### Patch Changes

- [#590](https://github.com/manyfold-open/manyfold/pull/590) [`a007e4b`](https://github.com/manyfold-open/manyfold/commit/a007e4bfa0abb80c6341452115fea387f0bcf1e5) Thanks [@yingca1](https://github.com/yingca1)! - The daemon no longer keeps a command's input on disk. A script sent as a command's input was saved with the command's record for up to a day; now it is only held until the command has read it.

## 5.3.0

### Minor Changes

- [#586](https://github.com/manyfold-open/manyfold/pull/586) [`60d28ae`](https://github.com/manyfold-open/manyfold/commit/60d28ae99603ff33c0ce52d742e9823ee8b60c2c) Thanks [@yingca1](https://github.com/yingca1)! - An agent's Storage page (titled Storage) shows its workspace and config sizes for a sandbox from the sandbox's last storage measurement, so they are there while the sandbox sleeps, with when they were measured. Refresh measures the sandbox now: admitted like any other wake, it wakes a sleeping sandbox and updates the paths and the sandbox filesystem size together, even within minutes of the last measurement. An agent on a sandbox shows that filesystem size as Storage in its Overview's Details. `POST /agents/:id/storage-usage/refresh` (`agents:edit`) is the new measuring call, `POST /agents/:id/storage-usage` never execs for a sandbox, and its report carries `measuredAt`; `mf agent storage-usage` reports a sleeping sandbox's cached paths instead of unknowns.

## 5.2.0

### Minor Changes

- [#579](https://github.com/manyfold-open/manyfold/pull/579) [`85898dd`](https://github.com/manyfold-open/manyfold/commit/85898ddeb468d6cec8c30fd741511cd6941448c9) Thanks [@yingca1](https://github.com/yingca1)! - Show subscription quota windows for Codex, Claude Code, and Antigravity accounts in runtime account cards and the composer model-source panel.

## 5.1.0

### Minor Changes

- [#569](https://github.com/manyfold-open/manyfold/pull/569) [`e4eab55`](https://github.com/manyfold-open/manyfold/commit/e4eab559326beea7f664310bba47002a270a638d) Thanks [@yingca1](https://github.com/yingca1)! - A turn now carries the directories it runs in — the agent's workspace and
  its framework's home — on the exec itself, instead of registering them with
  the daemon in a separate call just before the turn. A message to an agent
  whose workspace sits outside the machine's managed tree (a coding agent on
  a sandbox it shares with a service framework) no longer depends on that
  extra round trip landing before the machine sleeps; the daemon admits the
  exec's directory for that exec only. A daemon too old to read them is asked
  to update before the turn rather than failing mid-turn.

## 5.0.0

### Major Changes

- [#564](https://github.com/manyfold-open/manyfold/pull/564) [`ce45b52`](https://github.com/manyfold-open/manyfold/commit/ce45b5270e2571bcbb507cf1d33519edb83c7ac5) Thanks [@yingca1](https://github.com/yingca1)! - One machine is one host, one host has one daemon, and a runtime is one
  framework on one host. Every self-owned computer, stateful sandbox and cloud
  computer now runs a single `mf daemon` that carries all of its frameworks; the
  platform-managed runner runtimes that used to shadow each sandbox and pod are
  gone, and a host's daemon registers onto the host itself. Keep-alive moves from
  the runtime to the sandbox: the switch keeps the machine awake
  (`PATCH /sandboxes/:id/keep-awake`; `/agent-runtimes/:id/keep-alive` is
  removed), and stopping is host-level (`POST /sandboxes/:id/stop`;
  `POST /agents/:id/stop` is removed). Runtime providers replace sprites accounts
  and Kubernetes clusters in Admin (`/admin/runtime-providers`); sandboxes, pod
  hosts and agents are placed with `providerId` (`accountId` / `clusterId` are
  gone). Agent, runtime, sandbox and host summaries expose the host they live on
  (`hostId`, `hostName`, `powerState`, `daemonOnline`, `keepAwake`) and a derived
  `availability` instead of copied sprite / pod fields, agent status is the
  agent's own lifecycle (`pending` / `ready` / `failed`) and runtime status the
  install state (`installing` / `ready` / `failed`); the sprite-status stream
  emits host-status events. Daemon protocol: the register response no longer
  carries `runtimes`, the welcome frame's `runtimeIds` lists the runtimes on the
  host, and the daemon's local stores are scoped by the host id. CLI: `mf agent
create --account-id` becomes `--provider-id`; `mf runtime get`, `mf agent get`
  and `mf daemon status` print the host, provider, power state and availability.

## 4.9.0

### Minor Changes

- [#560](https://github.com/manyfold-open/manyfold/pull/560) [`1d3ae24`](https://github.com/manyfold-open/manyfold/commit/1d3ae24d614092618986bf86db2a82b30840c986) Thanks [@yingca1](https://github.com/yingca1)! - Add Antigravity CLI (Google's `agy`) as a coding agent framework. Antigravity
  CLI agents run on the stateful sandbox, Kubernetes and self-owned computer
  (daemon) runtimes and, like the other coding CLIs, take their model either
  from a platform provider — a saved or managed provider of the Gemini
  protocol, or a Gemini API key, on one of the models agy offers in its API-key
  mode — or from agy's own sign-in on the runtime: a Google account, including
  a Google AI Pro or Ultra plan, whose Claude and GPT-OSS models the model
  picker then lists too. Run `agy` in the agent's terminal to sign in. A
  platform provider never touches the runtime's own agy settings or sign-in.
  On sandboxes and Kubernetes, agy is installed at the exact release the
  Update Center pins, checked against the sha256 its GitHub release publishes,
  and its self-updater stays off there, a terminal user's `agy` included.
  Conversations resume with `agy --conversation` in chat and in the terminal,
  whose new messages sync back to the chat; the sessions panel lists agy's
  conversations; a turn cut off by an API restart finishes under its own
  message, read back from agy's conversation log; and a conversation can be
  handed to herdr 0.9.1 or newer. `mf daemon hooks install` adds agy's session
  hook: a conversation started in the terminal joins the chat list when the
  terminal closes, and leaving the TUI hands the conversation back.
  `mf agent create --framework antigravity-cli` takes `--google-api-key` and
  `--agy-model`. agy's own sign-in on a runtime needs the Manyfold CLI from this
  release there.

## 4.8.0

### Minor Changes

- [#556](https://github.com/manyfold-open/manyfold/pull/556) [`8cc4d50`](https://github.com/manyfold-open/manyfold/commit/8cc4d508dd09a88a50aee3783122603f43e9971c) Thanks [@yingca1](https://github.com/yingca1)! - The ask permission mode works again for OpenClaw turns on openclaw 2026.8.1 and later. Those releases reject the session's `execAsk` field, and the daemon used to drop that failure silently, so ask-mode turns ran with no command approvals and also lost the model picked for the message. For each ask-mode turn, the daemon now puts the OpenClaw session into openclaw's `guarded` permission mode: commands outside the allowlist need your approval, and file tools stay inside the session root. It clears that mode before the turn ends, so the next turn without ask mode runs as before. If the gateway rejects the session update (openclaw before 2026.8.1 does not know `permissionMode`), the turn now fails with the gateway's message instead of running without approvals or with a different model.

- [#556](https://github.com/manyfold-open/manyfold/pull/556) [`8cc4d50`](https://github.com/manyfold-open/manyfold/commit/8cc4d508dd09a88a50aee3783122603f43e9971c) Thanks [@yingca1](https://github.com/yingca1)! - The daemon now waits for the local OpenClaw gateway to answer before it starts an OpenClaw turn. `openclaw acp` and `openclaw gateway call` do not retry a refused connection, so a turn that arrived while the gateway was still booting failed within seconds, or ran without its model choice. The wait uses the turn's handshake budget (30 seconds by default). If the gateway still has not answered, the turn fails with `openclaw gateway did not answer on port <port> within <n>ms`, and nothing dials the gateway.

- [#555](https://github.com/manyfold-open/manyfold/pull/555) [`f026526`](https://github.com/manyfold-open/manyfold/commit/f0265269119d2c209d501ebb13a37ee8d4112e63) Thanks [@yingca1](https://github.com/yingca1)! - A turn on a sandbox whose runner has to be started no longer fails with "Chat runner unavailable" because the sandbox went to sleep while the runner was connecting. The sandbox is now kept awake from the moment its runner starts until the runner connects, whether a turn started it, a sign-in on the runtime page woke it, or an mf CLI upgrade restarted it. The first start after a CLI upgrade can take about a minute.

    A daemon no longer exits at startup when a herdr or coding CLI binary it finds cannot be executed, such as an empty file left behind by an interrupted install; that binary is reported without a version instead. A sandbox with an empty herdr gets herdr reinstalled the next time its runner starts, and a herdr update that cannot run herdr at all now says so instead of reporting a timeout.

### Patch Changes

- [#553](https://github.com/manyfold-open/manyfold/pull/553) [`c22ee13`](https://github.com/manyfold-open/manyfold/commit/c22ee132083522c0836b766ad0131c66d1ae2f4d) Thanks [@yingca1](https://github.com/yingca1)! - Harden A2A calls: invalidate peer tickets when their owner is deactivated, recover task results after a server restart, block DNS rebinding, and preserve concurrent agent configuration updates. Apply CLI send deadlines to discovery and streaming, report remote cancellation consistently, retain input and authentication prompts, and preserve HTTP error status and reasons.

- [#505](https://github.com/manyfold-open/manyfold/pull/505) [`2bf2163`](https://github.com/manyfold-open/manyfold/commit/2bf2163383203952839872211b977d2e7a8cbf66) Thanks [@yingca1](https://github.com/yingca1)! - Add a shared Claude Code/Codex plugin for mf-powered platform operations,
  skill-maintained workbench route rules, and live resource updates in
  the workbench across API instances. Unify the standalone and plugin
  manyfold-cli-usage skill, with identity-aware guidance and complete
  reference bundles while retaining its default-install identity.

    Refresh channels, installed and library skills, connections, agents and model
    configuration, API-managed files, and backups through account-scoped events.
    Preserve open form drafts and file navigation while catching up after reconnects.

## 4.7.0

### Minor Changes

- [#545](https://github.com/manyfold-open/manyfold/pull/545) [`a5f1f45`](https://github.com/manyfold-open/manyfold/commit/a5f1f45b099309f581cc12bd7fcac3e2468390f4) Thanks [@yingca1](https://github.com/yingca1)! - Daemons now need Manyfold CLI 4.6.1 or newer, the release that carries the scoped storage reports, Pi's session home, services on cloud computers and Hermes turns that no longer stall at startup. The API refuses registration, heartbeats and connections from an older daemon, and `mf doctor` and the daemon's refusal message name the new minimum.

    A daemon started by launchd or systemd against the official API updates itself within about six hours once it is idle. A daemon started by hand, or one pointed at a self-hosted API with auto-update off, stays refused until `mf update` runs and the daemon restarts. Sprite runners and cloud computers below the minimum are reinstalled when they are next used, and the cloud computer image now starts with CLI 4.6.1, so a new cloud computer registers straight away.

- [#514](https://github.com/manyfold-open/manyfold/pull/514) [`058b188`](https://github.com/manyfold-open/manyfold/commit/058b188a6af07e390fedd81ea80ac1dc1ae949c7) Thanks [@yingca1](https://github.com/yingca1)! - The runner no longer admits a framework home directory outside the core set by default. A framework that keeps its workspace under its own home now has the API register that root with the runner before a turn, so its agents keep working.

## 4.6.1

### Patch Changes

- [#537](https://github.com/manyfold-open/manyfold/pull/537) [`5f3b536`](https://github.com/manyfold-open/manyfold/commit/5f3b536d00e0d02e7fd51296112c4069fe2f2227) Thanks [@yingca1](https://github.com/yingca1)! - Fix A2A peer authorization and task delivery across the API, CLI and workbench:

    - Outbound peer grants use the current batch endpoint, and revocation addresses the target agent.
    - Reject private IPv4 addresses encoded as IPv4-mapped IPv6 in outbound A2A URLs.
    - Serialize message retries by caller and target before creating a session or starting a turn.
    - Preserve cancellation during turn startup and return the durable task state when completion races with cancellation.
    - Resubscribe to the persistent Chat event stream until the task finishes, with cleanup on client disconnect.
    - Respect artifact snapshots and replacements in external A2A responses. Human CLI streaming prints the final artifact text once; JSON mode continues to emit live events.

## 4.6.0

### Minor Changes

- [#529](https://github.com/manyfold-open/manyfold/pull/529) [`26d155f`](https://github.com/manyfold-open/manyfold/commit/26d155ff7220e576933f2284bdf64868ae826e2d) Thanks [@yingca1](https://github.com/yingca1)! - The daemon recognises a new startup method, `container`, set by the boot loop of the pod host runtime image: under it the daemon accepts `daemon.update` and restarts by exiting, while auto-update stays off so the platform decides its version. The self-owned machines page labels it "autostart · container". The new `manyfold-runtime-host` image carries the toolchains and OS packages frameworks need but no framework, for pods that install frameworks on demand; its boot loop keeps the daemon's mf on the pod's volume and falls back to the image's copy when an update will not stay up.

- [#531](https://github.com/manyfold-open/manyfold/pull/531) [`2ede298`](https://github.com/manyfold-open/manyfold/commit/2ede298f1d330e84e858d0081338c96fec9deb43) Thanks [@yingca1](https://github.com/yingca1)! - OpenClaw and Hermes run on cloud computers, and the create flow offers a cloud computer to install them on. The framework goes onto the computer's volume and its gateway becomes a service of the computer's daemon, which starts it, restarts it with a backoff after a crash, and keeps it running across the daemon's own updates; each framework gets its own address on the cluster's ingress, and its runtime is ready once the gateway answers its health check. Changing credentials or environment variables, toggling the OpenClaw Control UI and changing the framework version rewrite the service and restart it; removing the runtime stops the service and withdraws its address. The first agent of an OpenClaw or Hermes runtime is the gateway's built-in profile, as on a sandbox. The daemon advertises `services.v1` (service upsert, start, stop, delete and list) under the container startup method. The runtime host image moves to Node 24, which current OpenClaw requires.

    Also fixed on every runtime: an OpenClaw turn no longer fails with "model not found" when OpenClaw lists the agent's model with its provider prefix; a Hermes install pinned to a release runs that release's installer; a failed Hermes version change keeps the working install instead of removing it; and the daemon hands Hermes a FIFO for its output, since under the compiled CLI Hermes read its stdout as closed and turns stalled at the ACP handshake.

## 4.5.0

### Minor Changes

- [#513](https://github.com/manyfold-open/manyfold/pull/513) [`d5befb6`](https://github.com/manyfold-open/manyfold/commit/d5befb6338020d320087ea69f25868e5d303472c) Thanks [@yingca1](https://github.com/yingca1)! - The open-source build now ships only the core frameworks: Claude Code, Codex, Gemini CLI, Pi, OpenClaw, Hermes, Dify, Langflow and A2A. Any other framework is added by an edition through the framework registry, together with its API module, its web and admin presentation, and any sign-in hand-off it brings. An agent whose framework the running build does not register fails with `framework_unavailable`. The landing page, the create flows, the admin's runtime hint and the CLI's usage help describe the core set.

## 4.4.0

### Minor Changes

- [#341](https://github.com/manyfold-open/manyfold/pull/341) [`eb5eb47`](https://github.com/manyfold-open/manyfold/commit/eb5eb473ec0fc8cd86484a49220ff6e657eb6b7b) Thanks [@yingca1](https://github.com/yingca1)! - Add Pi (pi.dev) as a coding agent framework. Pi agents run on the stateful
  sandbox, Kubernetes and self-owned computer (daemon) runtimes and, like the
  other coding CLIs, take their model either from a platform provider — a saved
  or managed provider of the Anthropic, OpenAI or Google protocol, or a vendor
  API key — or from Pi's own sign-in on the runtime: the machine's own `pi`
  configuration, or a runtime account added from the create flow or the runtime
  page (run `pi` and use `/login` for a Claude Pro/Max, ChatGPT Plus/Pro or
  Copilot subscription, or an API key). Sessions resume with `pi --session-id`
  in chat and in the terminal, whose new messages sync back to the chat, and
  `mf daemon hooks install` adds Pi's session hook, an extension Pi loads on its
  own: leaving the TUI hands the conversation back, and a session started in the
  terminal joins the chat list when the terminal closes. A Pi turn cut off by an
  API restart finishes under its own message, read back from Pi's session file
  when the runner's stream cannot be picked up again. A Pi conversation can also
  be handed to herdr, like Claude Code and Codex. On sandboxes and Kubernetes,
  Pi's find and grep tools work out of the box: fd and ripgrep come with Pi
  there. The composer switches between the provider's models and the ones
  `pi --list-models` offers locally, the credentials dialog can move an agent to
  another vendor's provider, the four-step create flow lists Pi, and
  `mf agent create --framework pi` takes `--pi-api-key` with `--pi-provider`. A
  platform provider is what every turn uses on any runtime, gateways included:
  Pi's own sign-in or `models.json` on a machine never takes its place, while
  Pi's settings, skills and sessions still apply. Pi's own sign-in on a runtime
  needs the Manyfold CLI from this release there.

## 4.3.0

### Minor Changes

- [#504](https://github.com/manyfold-open/manyfold/pull/504) [`be6917f`](https://github.com/manyfold-open/manyfold/commit/be6917f8c354b65f2aef8def171e295d117cfc90) Thanks [@yingca1](https://github.com/yingca1)! - New `mf doctor`: one command that finds what is wrong with this machine's mf setup and says how to fix each problem. It checks the install (update available, which `mf` your PATH resolves to, `--api-url`/`--token`/`MF_*` overrides in this shell), then every profile on the machine: its sign-in and API (unreachable, not a Manyfold API — with the `/api` URL it should have been — database down, redirected to a sign-in page, rejected token and why), and its daemon (registration, process, autostart unit, a daemon still running an older binary than the one on disk, why it is offline from the last WebSocket close, coding agents on your PATH the daemon did not detect). Only `--profile` narrows it to one profile. It exits 1 when a check fails, with the report on stdout either way; `--json` gives the same report for scripts. A profile nobody uses (not current, no daemon, no autostart unit) can only warn. It writes nothing locally and never prints a token. The docs now give `dev` as the default profile of dev binaries.

### Patch Changes

- [#504](https://github.com/manyfold-open/manyfold/pull/504) [`be6917f`](https://github.com/manyfold-open/manyfold/commit/be6917f8c354b65f2aef8def171e295d117cfc90) Thanks [@yingca1](https://github.com/yingca1)! - The daemon no longer redials about once a second when the API turns its registration away. The API accepts the WebSocket upgrade and only then refuses a revoked, deleted, unbound or too-old daemon, and the reconnect backoff reset on every upgrade; it now resets only once the server takes the hello, and a refusal (close 4401, 4403, 4404, 4406 or 4409) is logged with its fix and retried slowly, from one minute up to one attempt every 15 minutes, so a machine registered again still comes back on its own. A rejected heartbeat is now logged with its status and error message (when the problem starts, changes and clears, not every 15 s) instead of being ignored, and a heartbeat times out after 15 s instead of piling up. `mf daemon start` passes `MF_CONFIG_DIR` into the autostart unit, so a daemon on a custom config dir no longer starts on the default one and exits forever. An invalid `MF_HTTP_TIMEOUT` stops the command with an error instead of silently using 30 s. `mf daemon status` no longer puts the API's raw response body into `apiError`; it reports the status and the error message. It also validates the registration the way `mf daemon start` does, and fails with the same error on one that start refuses, instead of showing it as configured.

## 4.2.0

### Minor Changes

- [#495](https://github.com/manyfold-open/manyfold/pull/495) [`ffb7124`](https://github.com/manyfold-open/manyfold/commit/ffb7124d82bb231fea4b6ae36d3a46bbbaae2ee0) Thanks [@yingca1](https://github.com/yingca1)! - Hand a chat session to herdr. When an agent's runtime has herdr installed — your own computer running the daemon, or a sandbox — the chat header's "Switch to TUI" becomes "Switch to herdr": the conversation's Claude Code or Codex TUI opens in a herdr pane (a workspace per agent, a tab named after the conversation), and the web's terminal view shows that herdr with the pane focused. Views follow the conversation on their own: a session held by herdr shows herdr, quitting the TUI there brings the chat back with what was said imported, and "Switch to Chat UI" takes the conversation back. The banner's Show in herdr / Continue in web / Back to web buttons are gone; the header switch is the only control. Sandboxes get herdr installed when their runner is set up, and the Update Center lists herdr next to the mf CLI for every machine and sandbox, with upgrade (and install) actions; the runtime detail page shows the herdr version. `mf daemon status` and `mf daemon doctor` report herdr availability and version.

### Patch Changes

- [#496](https://github.com/manyfold-open/manyfold/pull/496) [`52dec83`](https://github.com/manyfold-open/manyfold/commit/52dec83dcc14479da0eff2957ff9d37b4bb43fd4) Thanks [@yingca1](https://github.com/yingca1)! - herdr handoff follow-ups. Handing a sandbox conversation to herdr now honours the sandbox's terminal opt-in, like the browser terminal: the web asks to enable the terminal first, and the API refuses a sandbox whose terminal is off before waking its runner. A Claude Code handoff on a sandbox without model credentials in the terminal says which setting to turn on. Sandboxes that get herdr from the platform skip herdr's first-run welcome. In the web, right-clicks inside the embedded herdr go to herdr's own menu instead of the browser's; a conversation left in herdr comes back in herdr when you return to it or reload, and moving between conversations herdr holds keeps the same view and only moves herdr's focus; the notes that sat above the composer about herdr and the Chat UI move behind a "?" after the header's view switch (a stuck import keeps its banner, with retry and abandon). The daemon no longer raises a herdr notification each time the web moves focus. Handing the same conversation to herdr again takes over its existing tab instead of adding another, and a daemon that restarts (an upgrade, a sandbox runner brought back after a suspension) adopts the herdr panes it opened, so their conversations stay handed off and their tabs still close.

## 4.1.0

### Minor Changes

- [#476](https://github.com/manyfold-open/manyfold/pull/476) [`ad9b1e5`](https://github.com/manyfold-open/manyfold/commit/ad9b1e5f14ec0bf45d20fda2d29b2be3ec6e7300) Thanks [@yingca1](https://github.com/yingca1)! - File-based execs (`MF_DAEMON_EXEC_FILES=1`, ADR-0029 §4) now cover execs that run under a runtime auth profile and execs with temporary settings. The profile lease travels with the exec as a path in its meta (never the composed env): a daemon that adopts the exec after a restart re-stamps the lease with itself before it reconnects, and stops the exec instead if the lease is already gone or held by another live process; the temporary-settings directory is drained and removed at completion whichever daemon gets there. Only an exec that keeps stdin open still uses the pipe path.

- [#473](https://github.com/manyfold-open/manyfold/pull/473) [`035e697`](https://github.com/manyfold-open/manyfold/commit/035e697bb9a1ee84b1296bee029cd95e2abc2ac3) Thanks [@yingca1](https://github.com/yingca1)! - `mf daemon stop` now also ends the execs the daemon owns (by their recorded identity), and `--keep-execs` leaves them for the next daemon to adopt — which is what the platform's runner bring-up passes once a daemon advertises `exec.files.v1`. The systemd user unit `mf daemon start` writes carries `KillMode=process`, so a detached exec outlives the daemon's restart; whether that holds for the actual installation is decided at start (launchd: yes; systemd: only with `KillMode=process`; manual: no), logged as `exec survival`, reported by `mf daemon doctor`, and used by the update drain, which only waits for sessions that would die with the daemon and keeps admitting adoptable execs while an update is pending. `mf daemon status` shows how many running execs would survive a restart.

- [#474](https://github.com/manyfold-open/manyfold/pull/474) [`b8e1f90`](https://github.com/manyfold-open/manyfold/commit/b8e1f90b12273e34809097c04a824a2f7d513e75) Thanks [@yingca1](https://github.com/yingca1)! - A daemon started without an init unit (`manual`: the sprite runner, `mf daemon start --foreground`) can now take a remote upgrade when it is a standalone macOS / Linux binary and not the pod runner (ADR-0029 §5). The old process drives it: the downloaded binary must pass `--version` before it replaces anything (now true for every self-update), the running binary is kept as `<mf>.prev`, the daemon hands its running execs to a successor it starts detached and watches the successor answer on the control socket with the new version; if that never happens it stops the successor, restores `.prev`, relaunches it and refuses that target version until another one is chosen. The daemon advertises `daemon.update.manual` when it can do this, so the dashboard's upgrade works for such daemons and the platform upgrades a capable sprite runner through `daemon.update` instead of installing over it. A restarted daemon also tells the platform once, in its first hello, what it made of the execs it inherited and whether an upgrade was rolled back; both are recorded as audit entries on the daemon.

- [#471](https://github.com/manyfold-open/manyfold/pull/471) [`c4bcb8f`](https://github.com/manyfold-open/manyfold/commit/c4bcb8f3047e8ab494e106ded65c9c1c2a214f20) Thanks [@yingca1](https://github.com/yingca1)! - The daemon can run chat-turn execs without pipes (ADR-0029 §4, first slice, gray release off by default). With `MF_DAEMON_EXEC_FILES=1` on macOS / Linux, a plain exec (no runtime auth profile, no temporary settings, no interactive stdin) starts detached through a fixed `/bin/sh` wrapper: stdin comes from a file, stdout and stderr append to log files in the exec directory, and the wrapper commits the exit code as one line in `exit`. The daemon only tails those files, stamps every event with its source byte offset, and on restart adopts an exec that is still running when its pid, start time and boot id all match what it recorded — never signalling a recycled pid — or completes one whose exit line landed while nobody watched. Aborts and deadlines are persisted before they take effect (a timeout reports exit code 124, a signal death 128+n, a kill hits the whole process group), `exec.start` is idempotent by ref id, and the raw logs are deleted at completion. Windows keeps the pipe supervisor; every other exec keeps the pipe path until the next slices move it. `mf daemon start` logs whether the switch is on.

- [#470](https://github.com/manyfold-open/manyfold/pull/470) [`19a9156`](https://github.com/manyfold-open/manyfold/commit/19a9156d511e7750f9cea2473041f63c1719f404) Thanks [@yingca1](https://github.com/yingca1)! - Terminals now tell the platform which CLI session they are on (ADR-0029 §3, hook reporting).

    - `mf daemon hooks install | uninstall | status`: Manyfold's `SessionStart` / `SessionEnd` hooks for `claude` and `codex`, written as one marked script plus one marked entry per event in `~/.claude/settings.json` and `~/.codex/hooks.json`, next to your own hooks. `mf daemon register` asks once (`-y` says yes, `--no-hooks` says no); the choice is remembered and `mf daemon start` keeps the hooks current. A sprite runner installs them by default. The hooks act only inside a terminal Manyfold opened (`MF_TERMINAL_ID`), never print, and are not installed on Windows.
    - API: `POST /terminal/session-hooks`, reachable only with the token of a live Manyfold terminal. A resume that came back under a new id, or a compaction that changed it, moves the chat session to the new ref after importing the old ref's tail; a TUI that opens an idle chat session takes its hold; one that opens a session with a turn in flight, or held by another terminal, is left alone and the tab is warned; a session that started fresh in the terminal (`startup`, `/clear`, fork) becomes a chat session of its own — marked `origin: terminal` — when the terminal ends, if its transcript is not empty; `SessionEnd` gives the hold back and runs the import without waiting for the terminal to close.
    - Every terminal Manyfold opens now carries the full four-key runtime identity (`MF_API_URL` and `MF_DEPLOY_ENV` were missing on the daemon arm) plus `MF_TERMINAL_ID`, registered as terminal surfaces of the exec env contract.

- [#475](https://github.com/manyfold-open/manyfold/pull/475) [`673428d`](https://github.com/manyfold-open/manyfold/commit/673428d2d6eb25334f6edd22de25d45987e9b26e) Thanks [@yingca1](https://github.com/yingca1)! - Terminals on daemon agents now belong to the daemon rather than to the browser tab showing them (ADR-0029 §6). The daemon keeps the shell and a headless copy of its screen when the tab's connection drops or the tab closes; the workbench's reconnect, or the next open of a terminal for a session that shell holds, attaches to the same shell and gets the screen back, taking it over from any other tab (which is told with close code 4409). A terminal nobody is attached to is closed after 30 minutes, or 5 minutes under a runtime auth profile; "Back to web" ends it at once. The daemon lists the terminals it owns in every hello and heartbeat, and the platform now takes that list, not the tab's tunnel, as proof that a terminal's hold is alive: a terminal the daemon no longer reports has its row ended and its hold released, and a terminal no row claims is closed. `mf daemon status` shows the terminals kept and attached; a daemon keeps at most 8. Daemons without the capability (`pty.terminal.v1`) keep the previous stream-bound behaviour.

### Patch Changes

- [#467](https://github.com/manyfold-open/manyfold/pull/467) [`6567ab2`](https://github.com/manyfold-open/manyfold/commit/6567ab2f2f26bc4241044e103339b21ed40565cf) Thanks [@yingca1](https://github.com/yingca1)! - Automatically retry saved MCP and platform context configuration when a supported daemon reconnects. Serialize manual, on-change and reconnect delivery per computer, keep failed or superseded snapshots stale, and protect configuration files against delayed writes from retired connections or expired delivery attempts. Older daemons keep explicit push support and require a CLI update for automatic delivery.

## 4.0.0

### Major Changes

- [#463](https://github.com/manyfold-open/manyfold/pull/463) [`11ebadb`](https://github.com/manyfold-open/manyfold/commit/11ebadb44f2f97a89fd7d5a92cec1dc863492b30) Thanks [@yingca1](https://github.com/yingca1)! - Replace ambiguous agent `storageBytes`/`storageMeasuredAt` fields with nullable `workspaceBytes`/`workspaceMeasuredAt`. Add scoped cached sandbox storage reports, measurement freshness and conservative path attribution; runtime account reads require explicit account intent and `agents:read` consent.

    `mf sandbox storage-usage` reports the current sandbox, while `--account` reports all account sandboxes. `mf agent list --json` now returns `{ scope, agents }`; agent path diagnostics keep sleeping measurements unknown and expose cached sandbox usage separately. Upgrade the API and CLI together: storage commands and agent list/get reject older ambiguous responses.

## 3.0.3

### Patch Changes

- [#441](https://github.com/manyfold-open/manyfold/pull/441) [`3178178`](https://github.com/manyfold-open/manyfold/commit/3178178023a0a1a2f07da45d43fe56f309d8825d) Thanks [@yingca1](https://github.com/yingca1)! - Own temporary per-exec settings and terminate their isolated process tree before completing cancellation, cleaning resources before the final execution acknowledgment on every supported platform.

## 3.0.2

### Patch Changes

- [#422](https://github.com/manyfold-open/manyfold/pull/422) [`faf8b50`](https://github.com/manyfold-open/manyfold/commit/faf8b50cf4f2f49f2a716e8dcc5917c35513c6b0) Thanks [@yingca1](https://github.com/yingca1)! - Log daemon startup before bounded shell PATH probes, forcibly reap timed-out probe process trees and retain the original PATH fallback. Sign completed Darwin binaries with identifier ai.manyfold.mf and strictly verify signatures, archive contents and updater byte preservation before release upload. Ad-hoc signatures do not guarantee that macOS TCC permissions survive upgrades.

- [#433](https://github.com/manyfold-open/manyfold/pull/433) [`f8c2287`](https://github.com/manyfold-open/manyfold/commit/f8c22872c5032f66a5063213a7b82d8e2987152d) Thanks [@yingca1](https://github.com/yingca1)! - Wait for runtime-auth profile cleanup before completing executions, so immediate same-profile work can acquire the released lock. Report cleanup failures without exposing credentials and retain execution ownership until cleanup finishes.

- [#431](https://github.com/manyfold-open/manyfold/pull/431) [`cbd9d94`](https://github.com/manyfold-open/manyfold/commit/cbd9d946f34be473a4567f6142f6b18e5e960017) Thanks [@yingca1](https://github.com/yingca1)! - Retry temporary Windows file-replacement denial when publishing protected state and daemon ownership metadata. Keep the original target intact, retain the kernel lock during publication, and bound retries so persistent permission errors still fail startup cleanly.

## 3.0.1

### Patch Changes

- [#396](https://github.com/manyfold-open/manyfold/pull/396) [`415f45a`](https://github.com/manyfold-open/manyfold/commit/415f45ab8f2df2367de27c7dcb26b617a36d8fb3) Thanks [@yingca1](https://github.com/yingca1)! - Keep one daemon process per profile, preserve the current owner's PID and control socket during concurrent starts or cleanup, and recover ownership after a crash. Ignore obsolete WebSocket callbacks, keep reconnect attempts single-flight, and preserve new RPC cancellation handlers when older connections finish. Include optional process identity and complete hello records for diagnosing connection churn. Existing duplicate foreground processes should be stopped before updating and restarting the same profile.

## 3.0.0

### Major Changes

- [#366](https://github.com/manyfold-open/manyfold/pull/366) [`196b37d`](https://github.com/manyfold-open/manyfold/commit/196b37dc1b6fb5d19ab38bcbb467c894fd15cbf8) Thanks [@yingca1](https://github.com/yingca1)! - Clients now require the canonical Manyfold API contract. `mf whoami` calls
  `/auth/whoami` only and reports a missing endpoint instead of retrying
  `/auth/me` and constructing a legacy identity response. Login and setup still
  use `/auth/me` for their current account flow.

    The shared SDK recognizes structured errors only inside the `error` object.
    Legacy top-level `code`, `message`, and `details` fields no longer supply error
    metadata. HTTP status fallback and raw-response diagnostics remain available;
    CLI error output never prints an unparsed response body.

    Upgrade self-hosted APIs before deploying these clients. Servers must provide
    `/auth/whoami` and the `{ ok: false, error: { code, message, details? } }`
    response contract. Existing Agent runtime and external A2A identities are
    unchanged.

## 2.0.0

### Major Changes

- [#362](https://github.com/manyfold-open/manyfold/pull/362) [`a72fd5e`](https://github.com/manyfold-open/manyfold/commit/a72fd5e55423bfba77276928f047960c70ced0f2) Thanks [@yingca1](https://github.com/yingca1)! - Use `mf a2a send` to invoke a peer or URL and `mf a2a status` to list callable peers and in-flight tasks. The deprecated `call`, `stream`, and `peers` aliases have been removed. Replace `stream <url> <prompt>` with `send <url> <prompt> --stream`; replace scripts reading the `peers --json` array with `status --json` and read its `peers` field. Update saved scripts and Agent instructions before upgrading the CLI.

    The Web A2A exposure dialog now points to the supported status command in every language.

## 1.1.0

### Minor Changes

- [#354](https://github.com/manyfold-open/manyfold/pull/354) [`aef0bb7`](https://github.com/manyfold-open/manyfold/commit/aef0bb74954b2e95c40cf3e29f4c333fc8ddb4d8) Thanks [@yingca1](https://github.com/yingca1)! - Agent create (v1): the model provider section is built like the runtime section — an All / Cloud / Local chip row over one grid of pick cards (the saved providers and the runtime's accounts side by side, the chips only filtering) and one row of dashed add chips under it. Cloud lists the saved providers and adds new ones through the same built-in / custom forms as Settings → Model Providers, in a dialog that refreshes the list and picks the new row. Local lists the runtime's host sign-in and its added accounts as the runtime page's Account section shows them (same identity, plan and status tags, the same Sign in for a host or account that needs one, a Manage accounts link for the rest), signs a new subscription in from the page, and can now store an API key on the runtime: an `api-key` auth profile keeps the key in its own credential context on the host and injects it as the vendor variable for that profile's runs (needs an `mf` daemon advertising `auth-api-key.v1`; the API refuses the create on older ones). The runtime page's Account section and the create form's Local group now render one shared account list (`RuntimeAccountList`): the same rows, the same Sign in button and account menu, the same dashed "+ Add account" / "+ Add API key" chips and the same sign-in dialog; the create form only adds the pick. The accounts are laid out like the create form's runtime cards, two to a line: each account is headed by who it is signed in as (the host row is simply "Host sign-in" until it is), with plan and organization on one quiet line, its status tag, and Sign in on the row when it needs one; the host's usage sits two windows to a line, and the list ends with Add account. The explanatory copy that repeated what the rows already said is gone. Joining an existing runtime no longer offers a "Same credentials as the runtime" row: for a coding framework the runtime's credentials are the Local list (its host sign-in row is that binding), so a Cloud pick is always an explicit provider; the frameworks without a Local list (openclaw, hermes, external, and those that manage providers in their own UI) simply inherit, as before, and a subscription choice no longer sends an empty credentials PATCH.

    Sandbox runners come up earlier: a coding-framework agent create registers and starts the sprite's runner while the VM is still awake from the framework install (`starting_runner` step), picking a sandbox runtime in the create form prewarms its runner (debounced, same admission and metering as a click), and a runner woken for an account operation is held awake for a few minutes so the sign-in or key that follows does not wake it again.

    A sandbox delete whose sprites.dev call fails no longer pins the user's active-slot cap: revoked host rows are excluded from every concurrent-active count, and the sandbox reaper now retries the delete for a revoked row a few minutes later instead of leaving it as a permanent ghost. A wake refused by that cap is reported as its own state (`sandbox-limit`) on the runtime page and in the create form's Local list, with a check-again action, and is never cached as a failed probe.

    Account usage is read from the vendor at most once every ten minutes per runtime: the runtime page's opens and refreshes re-read the sign-in but reuse the kept usage, a refused re-read keeps the last good numbers (the card says when they were read), and the host card's menu has Refresh usage for an explicit re-read (`GET …/account?refreshUsage=1`; the daemon's `account.inspect` and the sandbox probe both accept a usage flag).

    The create form (v1) gathers every model setting under one Advanced config section after the provider: the framework's model mapping (folded) with its default model and effort for a platform provider on Claude Code or Codex, the primary model for openclaw / hermes, or the model override for an agent that simply inherits its runtime's credentials. The mapping now applies when joining an existing runtime too: the join sets the agent's model config right after its credentials. Both the Model provider and the Advanced config labels carry the same question-mark help as the framework and runtime labels, opening a short explanation of Cloud vs Local and of what the mapping does.

    Opening the create form for a runtime (`?runtimeId=`) no longer loses that selection to the first sandbox host when the hosts load before the runtimes.

    Each sandbox card in the create form (v1) shows every framework a sandbox can hold as icons — the three coding CLIs and the service frameworks — present ones in colour with a green edge, absent ones greyed behind a dashed edge — and each icon opens a menu with the installed version against the catalog, the agents already running that framework there (each a link to its chat), and the one action that closes the gap: Check (a sandbox never probed), Install, or Upgrade to the latest. A coding CLI on a bare sandbox installs through a new `POST /sandboxes/:id/frameworks/:framework/install` (the same staged npm install as the agent-level upgrade, re-probed and persisted afterwards); a sandbox that already runs the framework upgrades through its primary agent, as the runtime page does. The service frameworks are known through the runtime that runs them and install by a click too: the menu's Install brings the framework up on the sandbox as a runtime with no agent yet (installed and started, its model provider filled in by the first agent's pick), and the menu says when the sandbox's one public port is already taken by another of the three. Deep links into the form (`?sandboxId=`, `?runtimeId=`) no longer lose their target to the first host when the lists load in the other order.

    A bare sandbox that already has the coding CLI takes a subscription account before any agent exists: picking it in the create form (a click, a deep link or a sandbox just created — never the list's own default pick, which offers Add account instead and prepares on the click) brings the framework's runtime up on it right away (`POST /sandboxes/:id/frameworks/:framework/runtime` — an agent-less runtime row, the CLI left at the version found, only a missing one installed at the version agent create would pick; idempotent over a live runtime — the form's own prewarm starts the runner) and re-targets the form at that runtime, so Codex and Gemini CLI on a sandbox show the same Local group as Claude Code — host sign-in, added accounts, Add account / Add API key — instead of a "sign in after creating" row. A sandbox never probed is checked first (its CLI inventory read while it is awake), and one whose CLI turns out to be missing gets an Install chip in the same place — so a sandbox created from the form goes straight to its accounts, or straight to installing the framework, instead of the "sign in after creating" copy. A failed step shows why, with a retry. The agent then joins the runtime the way any later one would, promoted to its primary; the runtime page lists such a runtime with zero agents until then. A credentials change for an agent on a sprites runtime that has no stored credentials yet (one prepared this way) resolves from the request instead of demanding a rebuild.

    The Model provider section has the same shape for every framework now. OpenClaw and Hermes, which speak both vendors' protocols, list the saved providers of both families in one grid under All / Anthropic / OpenAI chips that only filter (the picked card's family is the vendor the primary-model default follows), with the same dashed "Add model provider" chip offering both families' catalog entries; the old Anthropic | OpenAI toggle over a separate list is gone. A framework that takes no provider from Manyfold shows one card saying it manages its model provider in its own UI, and creating such an agent no longer demands an unrelated saved provider.

    Every runtime card in the create form's Agent runtime section has a menu bottom-right. A sandbox card — bare, or the runtime on it — offers Rename runtime, Rename sandbox and Delete sandbox (once no agent runs there; its agent-less runtimes go with it): the sandbox is the machine the card stands for, so its runtimes are not deleted one by one from here. A cloud computer's card renames its runtime and deletes it once no agent is left; a daemon's runtimes are the daemon's own and only rename.

    While a picked sandbox is still on its way to being usable, the create button says so and stays disabled — Creating the sandbox… (the new-sandbox dialog closes on the click), Checking the sandbox…, Installing <framework>…, Preparing the sandbox…, Starting the sandbox runner… — so the form cannot be submitted around a step that is still running; the runner-starting line the account list used to show is that same progress and is gone from the list.

    The create form keeps waking the picked sandbox's runner until it answers (asking again after every cycle that ends without an answer) instead of handing the user a "start runner" line and button, so those never appear there; the plan's slot-cap notice keeps a Check again. The sandbox cards' status line says what the machine is doing — Active / Warm / Cold for the VM (the runtime list's words), Starting runner… and Runner online for the picked one — instead of a flat Ready.

    Waking a sandbox runner no longer stalls on a stale twin: when two registrations left two runner-host rows for one sprite, the wake picked one arbitrarily and could wait its full two minutes on the row the process was not using; the lookup now takes the row the runner last answered on.

    A sandbox woken for its accounts no longer sits in the plan's active slot for minutes after the user has moved on. The create form's prewarm holds it for a short window it renews while the runtime stays picked and releases when the pick moves or the page closes (`POST /agent-runtimes/:id/auth-profiles/release`); the runtime page releases the hold its Refresh or sign-in placed when it is left; and a wake the slot cap refuses first lets go of the account holds on the user's other sandboxes, so the next attempt is admitted once they suspend — on the Free plan's single slot, switching sandboxes in the form used to wait out a five-minute hold.

    A sandbox wake the plan refuses fails fast in the create form instead of spinning: the prewarm's admission now runs on the request and answers with the refusal (`RuntimeAuthPrewarmView.refused`), so used-up active hours end the wait at once — the card reads Can't wake, the Local group says the hours are used up with an Upgrade plan link where a plan is sold, and Create is not held — while a full concurrent slot keeps the wait going with the button saying it is waiting for another sandbox to fall asleep.

    Every lookup of a sandbox's runner by name now agrees on which row is the runner when a double registration left two: the one it last answered on. Before, the account list could read a sandbox as asleep off the twin nothing ever connected to while the wake reported the runner live — the create form then showed Starting the sandbox runner… indefinitely. The twin rows are dropped when found, once they are old enough not to be a registration still dialling in.

## 1.0.0

### Major Changes

- [#349](https://github.com/manyfold-open/manyfold/pull/349) [`77d8543`](https://github.com/manyfold-open/manyfold/commit/77d85432dbbdb2ee0f6cb60efc624a4a0b686c97) Thanks [@yingca1](https://github.com/yingca1)! - Close retired runtime and configuration compatibility windows. Daemon registration,
  heartbeats and WebSocket connections require CLI 0.34.0 or newer. Coding daemon
  prompts use stdin transport; turn RPCs use split budgets; update channels use stable/dev.
  Missing credential facts no longer establish readiness, and daemon MCP writes
  always use restrictive file permissions.

    Lark message ingress accepts only the current receive_v1 event contract. Retired
    API environment aliases fail startup, Web/Admin stop reading old build aliases,
    and startup no longer adopts A2A timeout or self-host plan settings. Upgrade older
    self-hosted installations through API 4.0.0 and migrate configuration first.

    Normal runtime provisioning, upgrades, skill activation and keep-alive operations
    no longer perform the completed identity, shared-shell, home-clone or fused-task
    migrations. Existing persisted workspace and lease state paths remain valid.
    Every service wake gets an independent report generation; changing a keep-alive
    lease preserves the current service's report fence and files.

## 0.34.0

### Minor Changes

- [#325](https://github.com/manyfold-open/manyfold/pull/325) [`cbfaaea`](https://github.com/manyfold-open/manyfold/commit/cbfaaea141ae3bcacc3a63dc73a112633969ccfe) Thanks [@yingca1](https://github.com/yingca1)! - Send daemon WebSocket credentials in the Authorization header instead of the
  URL. Self-hosted deployments must upgrade to Manyfold v0.5.0 (API 1.1.0) or
  newer before updating the daemon. Daemons advertise `ws.auth-header` so operators can verify the fleet
  before retiring query authentication.

## 0.33.1

### Patch Changes

- [#287](https://github.com/manyfold-open/manyfold/pull/287) [`86b872a`](https://github.com/manyfold-open/manyfold/commit/86b872a4e98422eebec26a01cfb50c96d7759ae2) Thanks [@yingca1](https://github.com/yingca1)! - Daemon connection-success logs no longer include the authentication URL or its
  bearer token. Existing server authentication remains compatible.

## 0.33.0

### Minor Changes

- [#288](https://github.com/manyfold-open/manyfold/pull/288) [`6b4d090`](https://github.com/manyfold-open/manyfold/commit/6b4d090f692764c94d2367b014e153b2c63d2dcd) Thanks [@yingca1](https://github.com/yingca1)! - Retire the Phase 8 user-grant compatibility layer. The API no longer exposes the legacy CLI poll route or bearer-grant endpoint, runtime authorization no longer uses `enforce_agent_binding`, and the web CLI approval screen keeps only browser login. External A2A grants remain supported.

## 0.32.0

### Minor Changes

- [#280](https://github.com/manyfold-open/manyfold/pull/280) [`193dfe4`](https://github.com/manyfold-open/manyfold/commit/193dfe4803346a0dc331a4f9500d9ca9fd160ac2) Thanks [@yingca1](https://github.com/yingca1)! - Runtime auth profiles (P2, execution contract): an agent can be bound to one of its runtime's auth profiles (`PATCH /agents/:id/runtime-auth`, compare-and-set on a binding version; also at create/attach via `runtimeAuthProfileId`), and every execution for that agent — chat turns over the daemon or the sprite runner, the agent terminal, and the model-capability probe — then runs inside that profile's credential context. The daemon (capability `auth-context.v1`) composes the context itself from an opaque `authSelection`: the profile's own credential files, every ambient vendor variable stripped from both the machine environment and the agent's extras, codex's state databases pinned to the native home, and the profile lock held for the process's lifetime so same-profile work runs serially. A host that cannot honour the selection (a bare sandbox without its runner, a pod, or an older mf CLI) refuses the execution rather than answering with the machine's native sign-in. Switching takes effect for the next execution; a turn already running keeps the context it started with.

- [#279](https://github.com/manyfold-open/manyfold/pull/279) [`055590f`](https://github.com/manyfold-open/manyfold/commit/055590fed25f93c2cad88a8527e8d7c55b916a08) Thanks [@yingca1](https://github.com/yingca1)! - Runtime auth profiles (P1, host store and management API): a coding-CLI runtime can now hold several vendor sign-ins, each in its own credential context on the host. The daemon gains `auth.list` / `auth.create` / `auth.inspect` / `auth.logout` / `auth.operation` RPCs and an `authLogin` mode for `pty.open` (capability `auth-profiles.v1`); a profile's view symlinks sessions, history and config back to the native CLI home so switching auth never forks configuration or transcripts. The API adds `/agent-runtimes/:id/auth-profiles` (list, create, inspect, login, logout, remove), `/agent-runtimes/:id/default-auth` and `/runtime-auth-operations/:id`, with profile metadata, operations and the agent binding columns in new tables. Executing a turn under a profile and the web UI follow in later releases; the existing ambient account probe is unchanged.

## 0.31.2

### Patch Changes

- [#252](https://github.com/manyfold-open/manyfold/pull/252) [`4b96e8c`](https://github.com/manyfold-open/manyfold/commit/4b96e8c929670b4a1827701444844b267a4dca32) Thanks [@yingca1](https://github.com/yingca1)! - Migrate legacy sprite runtime identities into encrypted storage before CLI or framework upgrades clean shared shell profiles.

## 0.31.1

### Patch Changes

- [#242](https://github.com/manyfold-open/manyfold/pull/242) [`e9f99df`](https://github.com/manyfold-open/manyfold/commit/e9f99df9c8a424c1cffc89474e596dc66898c87d) Thanks [@yingca1](https://github.com/yingca1)! - Add an iMessage channel provider

    Bind an agent to iMessage and reach it from the Messages app, in one-on-one
    conversations and in group chats. Apple publishes no iMessage API, so the
    channel talks to a BlueBubbles server you run on your own Mac: paste its URL
    and server password, and Register pings it, reads its version and installs the
    inbound webhook itself, so nothing has to be copied back by hand.

    iMessage has no bot identity to @-mention, so group messages are gated on
    literal wake words instead, stripped from the message before the agent sees it.
    Wake words are escaped as literals rather than compiled as user-supplied
    patterns, because parsing runs on the unauthenticated webhook path where a
    hostile regex would be a denial of service against every channel on the
    instance. Allowlists normalize handles, so `+1 (555) 555-0123` and
    `+15555550123` are one person.

    BlueBubbles can neither set custom headers nor sign its payloads, so inbound is
    authenticated with a per-channel secret embedded in the registered webhook URL
    and compared in constant time. That is weaker than every other channel here:
    the URL is a bearer capability, visible in the BlueBubbles webhook list and in
    tunnel logs, and the allowlist is not a second factor. The channel docs say so
    plainly. Outbound calls are re-checked against the private-address guard on
    every request, not only when the URL is saved, because a write-time-only check
    loses to DNS rebinding.

    Replies are flattened to plain text and split one bubble per paragraph, since
    Messages renders no markdown and cannot edit a sent message — so there is no
    streaming preview. Attachments work in both directions. Reactions, typing
    indicators, read receipts and reply threading are detected and reported but not
    implemented: they all require the BlueBubbles Private API helper, which needs
    SIP disabled on the operator's Mac.

## 0.31.0

### Minor Changes

- [#214](https://github.com/manyfold-open/manyfold/pull/214) [`2ad1d15`](https://github.com/manyfold-open/manyfold/commit/2ad1d15137d8452c0468b50f3e8f85381cb93370) Thanks [@yingca1](https://github.com/yingca1)! - Add the openclaw ACP transport for BYOD daemons (ADR-0027, O6), behind `MF_OPENCLAW_ACP`. The daemon now discovers the host's own resident openclaw gateway from its config on the heartbeat — port and reachability only, never the token, and never starting it — and reports it on the openclaw `DetectedFramework`. When the flag is on and the daemon advertises `turn.openclaw.acp`, a daemon openclaw chat turn is driven as `openclaw acp` against that gateway (the daemon is the ACP client, exactly like a hermes turn) instead of spawning `openclaw agent --local --json`: continuity is the gateway session key (`_meta.sessionKey`, never `session/resume`), the ask mode and per-message model pick are pre-patched in-box over the loopback gateway before the bridge starts, the approval card relays through the existing `turn.permission` RPC, and the turn's token usage is read back from the gateway transcript after the prompt (the ACP stream carries none) and billed. The turn is resumable — the daemon buffers the ACP frames, replayed via `exec.resume`. With the flag off, or against a daemon whose CLI predates the capability, the daemon keeps the legacy CLI-spawn path unchanged.

### Patch Changes

- [#215](https://github.com/manyfold-open/manyfold/pull/215) [`1829eb8`](https://github.com/manyfold-open/manyfold/commit/1829eb8914b60fe94bc5f738a23d6711a0031596) Thanks [@yingca1](https://github.com/yingca1)! - Add a Microsoft Teams channel provider

    Bind an agent to a Microsoft Teams bot and reach it from personal chats, group
    chats and team channels. Bring your own Azure Bot: paste its app ID, client
    secret and tenant ID, run Register to activate the channel, then download a
    ready-made Teams app manifest from the channel page and upload it to Teams.

    Inbound activities are authenticated by validating the Bot Framework JWT
    against Microsoft's key set, checking the audience, the issuer, the signed
    service URL and the tenant on the channel. Allowlists are keyed on Entra
    (Azure AD) object IDs, never on user names or email addresses, because those
    can be reassigned.

    Replies stream by editing one message, land in the originating channel thread,
    and support typing indicators and agent-initiated sends. Personal-chat
    attachments are read; files posted in a channel or group chat are not, because
    Teams strips the reference and recovering it needs Microsoft Graph admin
    consent.

## 0.30.3

### Patch Changes

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Lift the framework-neutral ACP decoders (event mapping, permission-request decode, session-state decode, model matching, stderr classifiers, auto-approve / reject option pickers) into `@manyfold/shared` so the API-side and daemon-side ACP clients share one copy, and introduce an `AcpDialect` seam (error prefix, log tag, legacy auto-approve id, optional session/prompt `_meta`) so a second framework plugs into the same client. The API ACP client class is now `AcpTurn` (dialect-taking), with `HermesAcpTurn` kept as an alias. Pure internal refactor with no behaviour change: a live turn and a replayed turn decode through exactly one implementation, and hermes keeps its byte-identical error strings and defaults.

## 0.30.2

### Patch Changes

- [#199](https://github.com/manyfold-open/manyfold/pull/199) [`2a51fa7`](https://github.com/manyfold-open/manyfold/commit/2a51fa740de47ca8284503772dc62f7d7a69d1b4) Thanks [@yingca1](https://github.com/yingca1)! - Add a Google Chat channel provider. Connect a Google Chat app to an agent to reach it from direct messages and spaces in Google Workspace: mention gating, one session per thread with replies nested under the message that started them, space and user allowlists with operator rights, inbound file downloads, and native slash commands.

    Google signs inbound requests with a JWT rather than an HMAC, so the channel verifies it against Google's key set in either audience mode the Chat API console offers — the endpoint URL (captured for you by Register) or the Cloud project number.

    Chat allows only one write per second in each space, shared with every other Chat app there, so this provider defaults its reply mode to Final and paces long replies. Live progress is available per channel. Sending files is not supported: uploading to Chat requires user authorization that an app cannot hold.

    `mf channels create --provider` lists the new provider.

## 0.30.1

### Patch Changes

- [#188](https://github.com/manyfold-open/manyfold/pull/188) [`832cd55`](https://github.com/manyfold-open/manyfold/commit/832cd5569a38397c17a2e4602428d4bf89af88e0) Thanks [@yingca1](https://github.com/yingca1)! - Codex agents can now run GPT-6 Astra. It joins the model catalog at the head of the default preference scan (Astra → GPT-5.6 Sol → Terra → Luna → GPT-5.5 → …), matching the priority order Codex 0.153.4 ships, so a provider that serves Astra now defaults new agents to it while providers without it keep resolving as before. The `max` and `ultra` reasoning levels move from unexposed to selectable, gated per model — Astra, Sol and Terra reach `ultra`, Luna stops at `max`, GPT-5.5 and older stay at `xhigh`. GPT-5.3 Codex is deactivated in the catalog: it no longer exists in the upstream Codex model list.

## 0.30.0

### Minor Changes

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - Switching a session to Terminal can now land you straight in the coding CLI's
  own interactive interface, resumed on that same conversation, instead of at a
  bare prompt. The chat view and the TUI become two front ends over one session.
  Works on sandbox and self-hosted (daemon) agents alike; a daemon needs a CLI
  new enough to advertise the `pty.command` capability, and one that is not says
  so rather than opening a plain shell under a UI that promised a resume.

    The command runs as the shell's argv rather than being typed into the pty, so
    there is no guessing whether the prompt is ready yet, and quitting the TUI
    leaves the interactive shell you would otherwise have had. Only the chat
    session id travels from the browser: the API looks up that session's own
    recorded reference and builds the argv, so no caller chooses what runs in the
    sandbox. Claude Code and Codex are supported; Gemini's resume takes a session
    index rather than an id, so it opens a normal shell.

    The resumed TUI opens in full-access mode (`--dangerously-skip-permissions` for
    Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex) and forces
    transcript persistence on, so continuing the conversation there stays in sync
    with the chat view rather than prompting for every action or silently
    discarding what you did. The runtime is already the trust boundary — your own
    daemon machine, or an externally-sandboxed sprite.

    Codex needs nothing further — it signs in on the sandbox at creation and its
    credentials are already on disk. Claude Code's are injected per turn and never
    persist, so its TUI has nothing to authenticate with unless you turn on the
    new per-sandbox **Model credentials in the terminal**, which is off by default
    and separate from the existing terminal switch. It is worth reading before
    enabling: anyone who can open that terminal can then read the key, which the
    API otherwise only ever returns masked. A runtime-local agent needs no such
    opt-in, only its CLI sign-in. When resuming is unavailable the terminal still
    opens as a shell and says which of the two things it was missing.

## 0.29.0

### Minor Changes

- [#144](https://github.com/manyfold-open/manyfold/pull/144) [`6ee91e5`](https://github.com/manyfold-open/manyfold/commit/6ee91e5679ad9e22f9f999b0b87663df5586f85a) Thanks [@yingca1](https://github.com/yingca1)! - Show the signed-in account and its usage on the runtime page, and sign in from there.

    The runtime detail page (`/settings/runtimes/<runtimeId>`) gains an Account section for Claude Code, Codex and Gemini CLI runtimes on self-owned machines and sandboxes: the signed-in identity (email, organization, plan), the sign-in status, and the subscription usage windows with their reset countdowns (Claude 5h/7d, Codex primary/secondary, Gemini per-model quota). The host reads the CLI's own credential files and calls the vendor usage endpoint itself; only the response and non-secret identity fields ever leave the machine.

    - CLI daemon: new `account.inspect` RPC, advertised through the `account.inspect` client feature. Runtime pages of daemons on older CLIs show an update prompt instead of a probe failure.
    - API: `GET /agent-runtimes/:id/account` (`?wake=1` to probe a sleeping sandbox, which starts the VM and reserves an active slot), plus a `runtimeId` target on the terminal websocket for a bare host shell.
    - Web: when the runtime is not signed in, "Sign in" opens an inline terminal on the host that starts the CLI's own headless sign-in (`claude auth login --claudeai`, `codex login --device-auth`, `NO_BROWSER=true gemini`); closing it re-checks the account. The chat sign-in card now recommends `claude auth login --claudeai` too.
    - On macOS machines the Claude and Gemini tokens live in the Keychain, which the daemon deliberately does not read, so identity shows but usage does not.

## 0.28.0

### Minor Changes

- [#97](https://github.com/manyfold-open/manyfold/pull/97) [`6510fb7`](https://github.com/manyfold-open/manyfold/commit/6510fb7b1709402ca45062bb37db592d956c6d89) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats gain interactive permission approval. The composer's permission menu now works for hermes with three modes mirroring hermes's own edit-approval trio — "Ask for approval", "Accept edits", and "Don't ask" (the default, byte-identical to the previous always-YOLO behavior for every caller that sends no mode). In the ask modes the turn drops `HERMES_YOLO_MODE`, aligns the session via ACP `session/set_mode`, and surfaces `session/request_permission` as an interactive card in the transcript instead of auto-approving; the card's request and settlement persist as stream events AND content blocks, so it survives reconnects and history, and a turn that ends without a resolution renders the card inert. Answers are delivered with `POST …/messages/:messageId/permissions/:requestId` and routed like cancel: the in-process coordinator first, the carrying daemon via the new `turn.permission` RPC second, and a durable `chat_permission_answers` row plus pg NOTIFY for a peer-owned interactive turn (the composite PK makes the second answer a 409 — first click wins). An unanswered ask denies after `HERMES_PERMISSION_TIMEOUT_MS` (default 5 min) with the request's own reject option, and pending asks tick the turn's inactivity budget so a human deciding never reads as a hang. Ask modes on a daemon without the new `turn.hermes.permissions` capability are refused with `hermes_daemon_permissions_upgrade_required` — never silently downgraded to YOLO. The daemon publishes a synthetic `_manyfold/permission_resolution` line into the exec buffer before the child's reply, so a replayed stream reproduces the settlement in live order.

- [#98](https://github.com/manyfold-open/manyfold/pull/98) [`5701b2f`](https://github.com/manyfold-open/manyfold/commit/5701b2fa489aefb84350e2eb9ba7162849fc7218) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats can switch models per message. The composer's model menu now works for hermes agents (options come from the agent's provider-models cache, which the model-config view serves for hermes too, with a filter box once the list grows past a screenful), and the choice is applied via ACP `session/set_model` — hermes persists a session's model in its own state.db, so env vars cannot move a resumed session. Every transport reconciles by diffing against the models state hermes reports on session/new|resume: an untouched session costs no RPC, and picking "Default" re-sends the default's id because a hermes session would otherwise keep the previous pick under a UI that claims otherwise. Daemon-carried turns gate on the new `turn.hermes.options` capability: an explicit switch on an older daemon is refused with `hermes_daemon_options_upgrade_required` (never silently dropped), while the auto-defaulted value skips quietly; a hermes build that predates `session/set_model` fails an explicit switch as `hermes_set_model_unsupported`. The daemon reports the session's models/modes state on the turn final, captured best-effort into `agents.extras.hermesAcp` for diagnostics.

### Patch Changes

- [#95](https://github.com/manyfold-open/manyfold/pull/95) [`bec1b35`](https://github.com/manyfold-open/manyfold/commit/bec1b356edf0467c51632946050a1a8858245a6b) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chat turns now show tool outputs and stop silently denying file edits. The ACP decoder maps terminal `tool_call_update` frames to `tool_result` events (in their own `hermes-acp-x-<n>` ordinal namespace, so a cross-deploy resume cannot re-key rows the old decoder already wrote), and both ACP clients answer `session/request_permission` with an option the request actually offers — the previous hardcoded `approve_for_session` matches no option id current hermes builds advertise, and an unknown id maps to deny on both of hermes's approval bridges, which rejected every file edit on up-to-date hermes images. Billing now also decodes the `cachedReadTokens`/`cachedWriteTokens` spellings the acp 0.9.0 prompt ack uses, so cache tokens stop falling out of usage records. Hermes's streamed `usage_update` ({used} of {size} context-window pressure — not billing) is no longer discarded: the turn's final reading lands on the assistant message and the message-details popover shows a context row.

## 0.27.1

### Patch Changes

- [#81](https://github.com/manyfold-open/manyfold/pull/81) [`1e5d661`](https://github.com/manyfold-open/manyfold/commit/1e5d661d7adc4a06e984e742f965a81e70c841bf) Thanks [@yingca1](https://github.com/yingca1)! - The daemon's hello and heartbeat now advertise `model.credential-facts`, a retroactive capability flag for the credentialFacts field its model.inspect responses already carry. No behavior change — the flag makes fleet coverage queryable from `runtime_hosts.client_features`.

## 0.27.0

### Minor Changes

- [#76](https://github.com/manyfold-open/manyfold/pull/76) [`113e790`](https://github.com/manyfold-open/manyfold/commit/113e790cf05bd7195dfbcad3c86a328274355229) Thanks [@yingca1](https://github.com/yingca1)! - `mf skills discover` is paginated: it now requests the paged discovery endpoint, gains `--sort featured|latest`, `--cursor` and `--limit` (default 100, the server max), prints a next-page hint on stderr when more results exist, and `--json` output changes shape from a bare array to the page object `{items, nextCursor}` (before: `[…summaries]`; after: `{"items":[…summaries],"nextCursor":"100"|null}` — scripts reading the JSON should switch to `.items`). The discover API route additionally emits a shape-usage telemetry event so the legacy bare-array branch has a measurable removal gate. Human-readable ordering follows the catalog's featured ranking instead of the legacy unranked order.

### Patch Changes

- [#75](https://github.com/manyfold-open/manyfold/pull/75) [`7ae7ca6`](https://github.com/manyfold-open/manyfold/commit/7ae7ca63358595e0f2507f22fad9c95d60a9dea2) Thanks [@yingca1](https://github.com/yingca1)! - Retire the legacy `A2A_TURN_TIMEOUT_MS` env fallback: a startup migration moves a still-set value into the `a2a_turn_timeouts` admin setting exactly once (never overwriting an admin's save), clamping it to the setting bounds (30s floor; 1h blocking / 24h async caps — out-of-range values change behavior and are logged), and the resolver now falls back to code defaults instead of the env var when the setting is absent. The API also warns at startup for every legacy `NCA_*`/`WEB_BASE_URL` env alias still set (key names only) and emits a telemetry event when a Lark channel delivers a pre-2.0 legacy-schema message, so both compatibility windows finally have usage signals. The daemon now advertises the `turn.budgets` capability (it has parsed split turn budgets since [#513](https://github.com/manyfold-open/manyfold/issues/513)/[#556](https://github.com/manyfold-open/manyfold/issues/556) — this makes that queryable), and `MF_CHAT_STREAM_FLUSH_MS` / `MF_TURN_ADOPT_REPOLL_MS` are documented in `.env.example`.

## 0.26.0

### Minor Changes

- [#69](https://github.com/manyfold-open/manyfold/pull/69) [`0f66aec`](https://github.com/manyfold-open/manyfold/commit/0f66aec076e7d5e6c4c070577e9e0653c9839278) Thanks [@yingca1](https://github.com/yingca1)! - The legacy device-code grant flow is removed. `mf login` loses `--poll`, `--wait`, `--scopes`, `--for-agent`, `--limit-to-agent` and `--resume` (and the pending-login file plus its automatic redemption on the next command): `mf auth ensure --scopes <list>` has been the capability-request path since the auth-model refactor, and production minted two grants through the old flow in the last thirty days. On the API, `/auth/cli/start` answers 410 with upgrade guidance when a request carries `requestedScopes`/`requestedAgentId`, `/auth/cli/poll` is a tombstone that always answers the same 410, and the approve/exchange paths refuse the (15-minute-lived) grant sessions a pre-removal deploy may leave behind — so no new `enforceAgentBinding=false` grant can be minted anywhere. Tokens the old flow already issued keep authenticating unchanged; their retirement is the auth-model refactor's Phase 8 and starts its observation window with this release.

## 0.25.0

### Minor Changes

- [#54](https://github.com/manyfold-open/manyfold/pull/54) [`f5b6347`](https://github.com/manyfold-open/manyfold/commit/f5b634742aa4bf76ebea6df73c7f52a6fcd8c311) Thanks [@yingca1](https://github.com/yingca1)! - Local config is now checked before it is trusted, and you can pick a model from
  it.

    The "Local config" model source used to treat the presence of a config
    directory as proof of a working login. Claude Code needed only `~/.claude` to
    exist; Codex accepted an `auth.json` it could not even parse; Gemini read
    `oauth_creds.json` without ever looking at the `expiry_date` inside it. On top
    of that the source skipped model validation entirely, so a signed-out machine
    advertised itself as ready and the failure only surfaced when a message was
    already on its way.

    Both inspect paths now report what they actually found — whether a token is
    present, when it expires, whether a refresh token can renew it, which
    third-party gateways `~/.codex/config.toml` configures — and the verdict is
    computed from those facts. Because the facts carry timestamps rather than a
    yes/no, a snapshot taken an hour ago stops claiming a live token without
    needing to be re-inspected. A sign-in that has expired with no way to renew is
    now reported in the composer and refused at send time; the refusal re-inspects
    the runtime first, so signing in again on that machine is enough to clear it.

    Two situations deliberately stay permissive. A daemon older than this change
    reports no facts, and a macOS host keeps its Claude token in the keychain,
    which a background daemon must not prompt for — neither can be judged, so
    both keep working exactly as before.

    Picking a model under "Local config" works now. The models your CLI reported
    are listed in the composer, alongside Claude's effort and Codex's speed and
    reasoning level, each with a "CLI default" entry that hands the decision back
    to the local CLI. Nothing is filled in on your behalf: a knob you never set
    sends no flag at all. `/model` in a channel and `mf model-config update
--model` set the model too — until now they reported success and silently
    discarded it.

    The concrete model id you pick is passed through as-is. The hosted path maps a
    version onto its family alias (`claude-sonnet-4-5` became `--model sonnet`)
    because it repoints that alias through the environment; a local CLI has no
    such indirection, so an agent whose stored model was a full id now runs that
    exact version.

    Also fixes the sandbox copy of the inspector, where an over-escaped pattern
    made `requires_openai_auth = true` unmatchable, letting a hosted runtime treat
    `OPENAI_API_KEY` as usable even when the local config required a ChatGPT
    sign-in.

## 0.24.0

### Minor Changes

- [#17](https://github.com/manyfold-open/manyfold/pull/17) [`a365fa8`](https://github.com/manyfold-open/manyfold/commit/a365fa8e2a3046e0826a13e22a824e7147508467) Thanks [@yingca1](https://github.com/yingca1)! - The installer is now manifest-driven and served from `https://manyfold.ai/cli/install.sh`.

    `install.sh` used to call the GitHub Releases API to find a release, scrape
    `browser_download_url` out of the JSON, and recover the CLI version from the
    asset filename. It now reads the same release manifest `mf update` reads, which:

    - removes the GitHub API dependency and its unauthenticated rate limit — the
      common failure mode was an installer that worked yesterday and 403s today;
    - drops the download from three requests to two, because the checksum travels
      inside the manifest instead of a detached `.sha256` that could be served from
      a different cache generation than the archive it describes;
    - stops depending on `releases/latest`, which is what makes it safe for the CLI
      to leave the edition release train;
    - supports `MF_CHANNEL=dev` for real (`staging` is accepted as the pre-rename
      alias), and `VERSION=` pins either a stable or a dev build.

    The script is also served by the web app at `/cli/install.sh`, so the advertised
    install command becomes:

    ```sh
    curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
    ```

    It is a committed copy under `apps/web/public/cli/`, kept honest by a
    byte-equality test: neither the OSS nor the cloud web Dockerfile has `apps/cli`
    in scope, so a build-time copy or a symlink would break the image builds.

- [#20](https://github.com/manyfold-open/manyfold/pull/20) [`c738de9`](https://github.com/manyfold-open/manyfold/commit/c738de9aa8e21810070569ae35c752cdb0aa6bf1) Thanks [@yingca1](https://github.com/yingca1)! - `mf update` now resolves releases through a JSON manifest instead of a plaintext
  `latest/version.txt` plus a derived download path.

    The old protocol asked the CDN for a version string, then built the asset URL
    and a sibling `.sha256` URL by string concatenation. That meant three requests
    where the checksum could be served from a different cache generation than the
    bytes it described, and it hard-coded the storage layout into every installed
    binary — so the artifacts could never move.

    A channel now points at one manifest, and the manifest names every artifact by
    absolute URL with its sha256:

    - `https://github.com/manyfold-open/manyfold/releases/download/cli-channels/{stable,dev}.json`
      for the channel head, and a per-release `manifest.json` so `mf update --to`
      and the daemon's remote upgrade can still reach an arbitrary past build.
    - Two round trips instead of three, and the checksum can no longer disagree
      with the archive it covers.
    - The binary derives no URLs, so a future storage move needs a new manifest,
      not a new release of the CLI.

    **The dev channel is ordered by commit, not semver.** Consecutive dev builds
    share a base version, so the comparator reported them equal forever. Builds now
    carry their source commit and build time, and `mf version --verbose` / `--json`
    report them — the dev channel sees an update when the commit moves even though
    `x.y.z` has not.

    **The dev channel is an update policy, not an environment.** It no longer
    carries its own API endpoint: both channels default to the production API, and a
    pre-production endpoint is selected per profile with an explicit `--api-url` at
    login. `mf update --channel dev` says so when it switches.

    Also in this change:

    - New `mf version` command: bare output is byte-identical to `mf --version`,
      with `--verbose` and `--json` adding channel, commit, build time, target,
      install method and paths.
    - The daemon's background auto-updater follows the **saved** update channel.
      It previously used the baked one, so a machine where someone ran
      `mf update --channel dev` kept auto-updating along stable, silently undoing
      the choice on the next tick.
    - `mf update` and the API share one version comparator (`compareCliSemver`)
      instead of keeping a second, prerelease-blind copy in the CLI.
    - The `daemon.update` RPC reports which commit it landed on.

    Channel switching stays on `mf update --channel <dev|stable>`; no `mf channel`
    command was added, because `mf channels` already manages messaging channels and
    the singular/plural pair would be a permanent trap.

### Patch Changes

- [#15](https://github.com/manyfold-open/manyfold/pull/15) [`1909ba4`](https://github.com/manyfold-open/manyfold/commit/1909ba441c54570ff977b1399c9e08d39a2afaf7) Thanks [@yingca1](https://github.com/yingca1)! - Rename the mf CLI's pre-release update channel from `staging` to `dev`
  throughout. The channel a user selects with `mf update --channel dev` and the
  name the product reports are now the same word.

    - The runtime list labels the channel "Dev" instead of "Staging".
    - `staging` stays accepted as an alias everywhere it can arrive from an older
      peer: the `--channel` flag, a saved `~/.manyfold/update-channel.json`
      preference, the `daemon.update` RPC payload, and version strings — builds
      published before this rename are versioned `x.y.z-staging.<stamp>.<sha>` and
      are still installed in the field, so they keep reading as dev builds.
    - `GET /daemon/cli-versions` gains a `dev` list; the `staging` list is retained
      as a deprecated mirror so an older web bundle keeps working against a newer
      API during a rolling deploy.

    No distribution or update-source behaviour changes here.

- [#18](https://github.com/manyfold-open/manyfold/pull/18) [`d454437`](https://github.com/manyfold-open/manyfold/commit/d4544372f03391943400bf874f87c9bcbaac386b) Thanks [@yingca1](https://github.com/yingca1)! - The CLI now builds and publishes from this repository, on its own release train.

    Two channels, two triggers:

    - **stable** — a `cli-v<version>` tag. `release-cli` builds the five targets,
      creates the `cli-v<version>` release, then promotes that release's manifest to
      `stable.json`.
    - **dev** — every `develop` commit whose `ci` run passed. `release-cli-dev`
      builds the same five targets, attaches them to the rolling `cli-dev`
      prerelease, then rewrites `dev.json`.

    Both write the channel pointer last, so a reader never sees a manifest naming an
    artifact that is still uploading. The pointers live on a fixed `cli-channels`
    prerelease, which keeps their URLs stable forever.

    The dev channel is gated on CI completion rather than on push, because it has
    to mean "latest successful develop build" — a red build must never become the
    thing every dev machine installs.

    `ci` now also runs on `develop` pushes, and a `sync-release-to-develop`
    workflow back-merges `main` after a version PR; without it `changeset version`
    would delete consumed changesets on `main` only and the next promotion would
    resurrect them.

Notes before 0.23.3 predate this repository's public history; they live on
the docs site's changelog pages.

## 0.23.3

### Patch Changes

- `mf daemon register` now resolves its API endpoint the same way every other command does: an explicit root `--api-url` wins, then the profile's stored `apiUrl` from `mf login`, then the channel default. Previously the stored profile endpoint was skipped, so a machine logged into a self-hosted API silently tried to enrol against the default endpoint and was told its daemon token did not exist.
