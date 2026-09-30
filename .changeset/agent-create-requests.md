---
'@manyfold/api': minor
---

Repeating an agent create no longer builds a second agent:

- While a create runs, the same request (same name and settings) attaches to it instead of starting another one. It gets the same progress, then the same agent, with `resumed: true` on the `complete` event. A request for that name with other settings answers 409 `AGENT_CREATE_IN_PROGRESS`.
- Repeating a create that already finished returns the agent it made instead of `AGENT_NAME_TAKEN`, for a day or until that agent is deleted.
- A create whose API process stopped part-way ends as `AGENT_CREATE_INTERRUPTED` (503) after two minutes without progress. Its `details` name the sandbox it may have left behind, and the name can be used again.
- `POST /agent-runtimes/:id/agents` holds the name the same way, and now refuses a name already in use (`AGENT_NAME_TAKEN`).
- Create responses carry an `x-agent-create-request` header naming the request. A client that lost the connection can repeat the request with that header: it follows that create to whatever end it came to, its agent or its error, and never starts another. An unknown or mismatched id answers 404 `AGENT_CREATE_NOT_FOUND`.
- The NDJSON stream sends a blank line every 15 seconds so that proxies and client idle timers don't cut a long step.
