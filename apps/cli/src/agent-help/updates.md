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
