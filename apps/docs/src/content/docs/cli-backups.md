---
title: Back up and restore agents
description: Create snapshots, restore agent state, and track restore operations with mf.
order: 8
---

# Back up and restore agents

Backups capture an agent's restorable state. Create one before destructive
runtime or agent changes and keep separate copies of files you cannot afford
to lose.

## Create and list backups

```sh
mf backups create agt_xxx
mf backups list --agent-id agt_xxx
```

Use the returned backup ID for restore or deletion. `--json` is useful when a
script must retain the exact ID.

## Restore an agent

Restore replaces the agent's current state:

```sh
mf backups restore agt_xxx --backup-id abk_xxx --yes
```

The CLI requires `--yes` and does not open an interactive prompt. Before
passing it:

1. Verify both the agent ID and backup ID.
2. Stop or finish work that is still writing to the agent.
3. Create a fresh backup of the current state when rollback matters.

Add `--json` when an unattended restore needs machine-readable output.

The restore command returns an operation ID. Check it until the operation
reaches a terminal state:

```sh
mf backups get-restore abr_xxx
```

Do not report a restore as complete merely because the request was accepted;
use `get-restore` to verify the final status.

## Delete a backup

```sh
mf backups delete abk_xxx --yes
```

Backup deletion is irreversible. The CLI refuses it without `--yes`; confirm
that no planned rollback or audit workflow still references it.

## See also

- [Manage agents with the CLI](../cli-agents/)
- [Manage runtimes with the CLI](../cli-runtimes/)
- [CLI command reference](../cli-reference/)
