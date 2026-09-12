---
version: '2.0.0'
date: '2026-09-12'
---

A2A uses one command to send work and one to inspect peers and running tasks.
The deprecated `call`, `stream`, and `peers` aliases are removed. Update saved
scripts and Agent instructions before upgrading:

| Previous command                | Supported command                     |
| ------------------------------- | ------------------------------------- |
| `mf a2a call <target> <prompt>` | `mf a2a send <target> <prompt>`       |
| `mf a2a stream <url> <prompt>`  | `mf a2a send <url> <prompt> --stream` |
| `mf a2a peers`                  | `mf a2a status`                       |

`status --json` returns an object containing `peers` and `inflight` arrays.
Scripts that read the previous `peers --json` array must read the `peers` field.
The `send --async` and `tasks` commands retain their existing behavior.

Existing daemon registrations, runtime credentials, profiles, and workspaces
remain valid. The HTTP peer-list endpoint is unchanged.
