# Sandboxes

## List and delete

```sh
mf sandbox list --json
mf sandbox delete <sandbox-id|name> --yes
```

`list` shows each sandbox with its state, agent count, the frameworks
installed on it (`runtimes`) and its Manyfold CLI version (`old → new` when
an update is out; `cliVersion`, `latestCliVersion`, `cliUpdateAvailable` in
JSON), plus how many sandboxes the plan includes (`quota`: `used`, `limit`,
`plan`). Deleting an agent does not free its
sandbox; deleting the sandbox does. `delete` is irreversible, refuses
without `--yes`/`-y`, and answers `HOST_NOT_EMPTY` while agents are on it,
naming them. It needs `sandboxes:read` and `sandboxes:edit`; `list` needs
`sandboxes:read` and `agent-runtimes:read`.

To reuse a sandbox instead of creating one, pass it to
`mf agent create <name> --sandbox <id|name>` (`mf help agent --agent`).

## Update the Manyfold CLI on a sandbox

```sh
mf sandbox update <sandbox-id|name>
mf sandbox update <sandbox-id|name> --to <version> --json
```

`update` installs the sandbox's channel's latest Manyfold CLI, or `--to`
one version the web's Update Center lists (`mf updates versions cli`, dev
builds included), and
prints `from → to`; `--json` emits `{ id, name, from, to, sandbox }`.
A sandbox busy with work takes the update when that finishes, and is kept
awake until it does: it says how many sessions it waits for, and
`sandbox.cliUpdateDeferred` carries `{ activeSessions, deadline }`.
Already on the latest release, it says so and lists newer builds for
`--to`. It needs `sandboxes:read` and `sandboxes:edit`. To update every
sandbox, and what else is behind, use `mf updates` (`mf help updates --agent`).

A file operation, upload or chat attachment on a sandbox whose CLI lacks
what it needs answers `SANDBOX_CLI_TOO_OLD` (409) with the reason and
`details` (`hostId`, `hostName`, `cliVersion`, `latestCliVersion`):
update that sandbox, with `--to` a newer build when its channel's latest
is the one it runs.

## Storage

`mf sandbox storage-usage --json` reports the current agent's sandbox. It uses
`--agent-id`, `MF_AGENT_ID`, or the authenticated runtime identity. A human token
without an agent context must choose `--agent-id` or `--account` explicitly.

```sh
mf sandbox storage-usage --json
mf sandbox storage-usage --account --json
```

The account command requires `agents:read` consent for runtime identities. A
denial returns the existing owner-consent URL and no partial account report.
Human account sessions and full API tokens keep their account access.

The response states `scope` and `unit`. `storageBytesTotal` is the sum of its
host rows from one database snapshot. Hosts are ranked by storage descending;
empty sandboxes are included. `storageFreshness`, `storageMeasuredAt`, and
`asleep` describe cached readings. This command never executes a measurement
or wakes a sandbox.

`workspaceBytes` is the raw measured workspace size. `attributedBytes` removes
known overlapping paths from the breakdown; unknown attribution remains null.
Attribution is based on apparent file sizes, not provider invoices, hardlink
accounting or copy-on-write allocation. A current-sandbox response includes
only the current agent's identity and attribution, while its host total still
describes the whole sandbox.

`mf agent storage-usage <agentId> --json` is a different diagnostic: its scope
is `agent-paths`. For an agent in a sandbox it reports the workspace/config
readings of the sandbox's last storage measurement, as of `measuredAt`, and
never wakes the sandbox; `cachedSandbox` carries the separate cached
whole-sandbox reading. On any other machine it inspects the paths while the
machine is reachable.
