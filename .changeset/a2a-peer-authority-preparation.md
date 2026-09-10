---
'@manyfold/api': major
---

Use the dedicated A2A peer-grant table for authorization, caller lists and
revocation. Reconcile previously revoked token mirrors that left policy active,
backfill older grants and preserve existing public grant IDs. Temporary database
compatibility triggers protect old writers during rolling deployment.

Caller-bound long-lived A2A token creation now returns 410. Use the existing
batch peer-grant endpoint and per-call peer tickets for internal agent access.
External caller-less A2A credentials retain their single-target behavior.

Deploy this preparation version to every API instance before stopping mirror
writes and applying the final cleanup. The mirrors and compatibility triggers
remain only for that deployment transition.
