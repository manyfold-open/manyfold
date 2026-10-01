# Updates (the Update Center)

## List what is pending

```sh
mf updates list --json
mf updates list --kind cli
mf updates list --where sandbox-001
```

`list` (also plain `mf updates`, or `updates ls`) shows every pending update
on the user's computers, sandboxes and cloud computers, the frameworks on
their runtimes, and the agents' skills: the same rows and statuses as the
web's Update Center. Each row has a `kind` (`cli`, `herdr`, `framework`,
`cli-usage`, `skill`), the version it is on (`installedVersion`), the one it
would go to (`latestVersion`), and a `status`:

- `ready`: it can run from here.
- `required`: the installed version is below a minimum or in a blocked
  range; `blockedReason` says why.
- `manual` (`by hand` in the table): a person has to do it on that machine;
  `guidance` gives the command.
- `offline`: the machine cannot be reached right now.

`runnable` says whether it can run from here. Row ids are stable:
`cli:daemon:<hostId>`, `cli:sandbox:<sandboxId>`, `cli:podHost:<id>`,
`herdr:daemon:<hostId>`, `herdr:sandbox:<sandboxId>`,
`framework:<runtimeId>`, `framework:host:<sandboxId>:<framework>`,
`skill:<agentId>:<skillId>` and `cliUsage:<agentId>:<skillId>`.

`--kind` keeps one kind. `--where <name|id>` keeps one computer, sandbox,
cloud computer, runtime or agent; a name two places share is refused, so
pass the id.

`--json` emits `{ updates, errors }`. The list joins seven sources. One that
does not load goes into `errors` (`source`, `code`, `status`, `message`),
its rows are left out, and the command still exits `0`. Only when nothing
loads does it fail, with that failure's exit code.

## Apply

```sh
mf updates apply --yes
mf updates apply --kind cli --yes --json
mf updates apply cli:sandbox:<sandboxId> --to <version> --yes
```

`apply` runs the ids given, or every update that `--kind` and `--where`
select and that can run from here. Rows that cannot (by hand, offline) are
skipped and listed in `skipped`. Updates run one at a time, in the web's
order: skills, sandboxes, computers and cloud computers, frameworks, and
rebuilt frameworks last. It keeps to the API's five computer updates a
minute (herdr included) and waits out one `429`. One update can take
minutes: the server answers once it is through.

Each result is `updated`, `pending` (the machine takes it once its sessions
or current work finish; `mf updates list` shows when it has), or `failed`
with the error's `code` and `message`. `--json` emits
`{ results, skipped, summary, errors }`. `apply` exits `1` when any update
failed, and `0` when the rest are updated or pending.

Without `--yes` it shows the plan and asks on a terminal. A shell that
cannot answer, and every `--json` run, needs `--yes`. `--to <version>`
picks the version for exactly one update, from its `targetChoices`
(`mf updates list --json`).

It needs `sandboxes:edit` for sandboxes, `agent-runtimes:edit` for
frameworks and cloud computers, and `skills:edit` for skills, which an
agent-bound token cannot install for other agents; computers need a login
session or a full-access token.

## Versions

```sh
mf updates versions
mf updates versions cli --json
mf updates versions claude-code
```

Without a name, `versions` lists the latest mf CLI (stable, plus the dev
build where the deployment offers one) and each framework's latest. `cli`
lists the mf CLI versions there are to install: `mf update --to <version>`
for this machine, `mf sandbox update <sandbox> --to <version>` for a
sandbox. A framework name lists its versions newest first and the ranges
the platform refuses to install, with the reason.

## This machine's mf

`mf update` updates the `mf` you are running and needs no login. `mf updates`
covers the other machines and what runs on them.

## Access

`list` reads sandboxes, cloud computers, runtimes and skills with
`sandboxes:read`, `agent-runtimes:read` and `skills:read`. The user's
computers and both version lists need a login session or a full-access
token. With an agent's own token they come back in `errors` as `401` and
their rows are missing; `versions` then fails with exit `3`.
