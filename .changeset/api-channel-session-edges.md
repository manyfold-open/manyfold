---
'@manyfold/api': minor
---

Channel sessions handle three edge cases correctly.

- Deleting an inactive session with `activateFallback` no longer fails with a `500`. Only deleting the active session activates a fallback; before, a second active session broke the one-active-per-scope rule.
- Deleting a session that is already archived keeps the time it was archived.
- Switching to an archived session is now a `409` `channel_session_archived` with the scope in `details`, and a rename in the same request is not applied. Before, it answered `200` and changed nothing, apart from the rename. Creating a session without a `scopeKey` is now a `400`, not a `404`.
