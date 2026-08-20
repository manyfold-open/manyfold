# mf backups — agent guide

## Purpose

Snapshot an agent's state into a backup, list existing backups, delete
old ones, and restore an agent from a backup. Restore REPLACES the
agent's current state — it is disruptive. Always confirm with the user
before running `restore` (and before `delete`, which is irreversible).

## Required scopes

> Required **only for `--account`** (account-wide) actions. Operating your
> **own** agent (the default) needs no permission.

- `backups:read` — list backups and their metadata; check restore status
- `backups:edit` — create a backup, delete a backup, or restore an agent

Missing a scope? `mf auth ensure --scopes <missing>` — see `mf help auth --agent`.

## Common commands

```sh
mf backups list --agent-id $MF_AGENT_ID --json
mf backups create <agent-id>
mf backups restore <agent-id> --backup-id <backup-id> --yes --json
mf backups get-restore <restore-id>
mf backups delete <backup-id> --yes
```

- `list` (alias `ls`): omit `--agent-id` to list across all agents.
- `create <agent-id>`: snapshots the agent now; prints JSON.
- `restore <agent-id> --backup-id <id>`: requires `--yes` (or `-y`);
  returns a restore record — poll its status with `get-restore`.
- `delete <backup-id>` (alias `rm`): requires `--yes` (or `-y`).

## Output

- `list`: one line per backup — `id  sourceAgentName  status  bytes`;
  prints `(no backups)` when empty. `--json` emits the raw array.
- `create` and `get-restore`: always print raw JSON.
- `restore`: prints `id  status  backup=<id>`; `--json` for the full
  record. Watch `status` via `get-restore <restore-id>` until it
  completes.
- `delete`: prints `✓ deleted <backup-id>`; `--json` emits `{ ok, id }`.
- No secrets appear in backup output; ids and metadata are safe to show.

## Failure recovery

- "not authenticated" → `mf help auth --agent`
- `401` → missing scope; request just that scope (existing ones are
  kept): `mf auth ensure --scopes <missing scope>`, then retry
- `403` → the action targets a different agent than your identity; act on
  `$MF_AGENT_ID`
- "refusing to delete … without --yes" / "restoring overwrites …" →
  the command needs `--yes`; confirm with the user first, then re-run
  with `-y`
- restore stuck or failed → check `mf backups get-restore <restore-id>`
  and report the `status` to the user instead of retrying blindly
