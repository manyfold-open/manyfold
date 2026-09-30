---
'@manyfold/api': minor
---

Agent create reports failures a client can act on:

- The NDJSON stream's `error` event now carries the `code`, `status` and `details` the same failure would have as a plain HTTP response (for example `RUNTIME_LIMIT_REACHED` with the plan's `current`, `limit` and `planName`).
- A create whose placement cannot be resolved now fails with an ordinary HTTP error instead of leaving the stream without a response.
- A name already in use answers `AGENT_NAME_TAKEN`, with the existing agent's id in `details`; renaming an agent onto a taken name does the same.
- Adding an agent to a sandbox that already runs the framework refuses credentials in the request (`JOIN_INHERITS_CREDENTIALS`) instead of silently dropping them: the agent uses the credentials of the instance it joins.
