---
title: Back up and restore agents
description: Create snapshots, restore agent state, and track restore operations with mf.
order: 8
---
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

Only one backup or restore can run on a workspace at a time. An overlapping
request returns a conflict; wait for the current operation to finish before
retrying. If an operation is interrupted, retry can remain unavailable until
its file operations have stopped and cleanup completes.

When upgrading from a version without workspace operation locking, pause new
backup and restore requests, let existing operations finish, and update all API
instances before resuming these requests. Old and new API versions must not
accept backup jobs concurrently during this first upgrade.
The migration refuses to proceed while an older running job has no operation
owner. Once migrated, the database rejects new unowned jobs from old API versions.

## Restore an agent

Restore replaces the agent's current state:

```sh
mf backups restore agt_xxx --backup-id abk_xxx --yes
```

The CLI requires `--yes` and does not open an interactive prompt. Before
passing it:

1. Verify both the agent ID and backup ID.
2. Stop or finish work that is still writing to the agent.
3. Create a fresh backup of the current state when rollback matters, and wait
   until it is marked `succeeded`. Do not restore after a failed or timed-out
   safety backup.

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

> **Warning:** Backup deletion is irreversible. The CLI refuses it without
> `--yes`; confirm that no planned rollback or audit workflow still references
> it.

## See also

- [Manage agents with the CLI](/docs/cli/agents/)
- [Manage runtimes with the CLI](/docs/cli/runtimes/)
- [CLI command reference](/docs/cli/reference/)
