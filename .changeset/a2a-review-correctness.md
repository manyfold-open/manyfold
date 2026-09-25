---
'@manyfold/api': patch
'@manyfold/cli': patch
'@manyfold/web': patch
---

Fix A2A peer authorization and task delivery across the API, CLI and workbench:

- Outbound peer grants use the current batch endpoint, and revocation addresses the target agent.
- Reject private IPv4 addresses encoded as IPv4-mapped IPv6 in outbound A2A URLs.
- Serialize message retries by caller and target before creating a session or starting a turn.
- Preserve cancellation during turn startup and return the durable task state when completion races with cancellation.
- Resubscribe to the persistent Chat event stream until the task finishes, with cleanup on client disconnect.
- Respect artifact snapshots and replacements in external A2A responses. Human CLI streaming prints the final artifact text once; JSON mode continues to emit live events.
