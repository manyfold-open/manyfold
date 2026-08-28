---
'@manyfold/api': minor
---

Every hermes chat turn now speaks ACP. A daemon-runtime turn requires a daemon
that advertises `turn.hermes` — one that does not gets a non-retryable error
naming the fix (`mf update`) instead of the retired in-API pipe fallback. A
sprite turn prefers its runner-owned `turn.start` (resumable, now attempted
unconditionally rather than behind the rollout allowlist), and falls back to an
API-driven `hermes acp` over the interactive sprite exec channel; a k8s turn
runs the same client over an interactive pod exec. The OpenAI-compatible
gateway POST that used to carry sprite-without-runner and k8s turns is gone
from chat entirely — the resident gateway keeps serving health probes and the
dashboard. The `MF_HERMES_TURN_RPC` and `MF_HERMES_ACP_RESUME` flags are
retired; resume is always on for daemon-carried turns.

Two long-standing gaps are fixed on the way: an exec'd or runner-spawned
`hermes acp` never saw the resident service env, so the provider alias key
(`OPENROUTER_API_KEY` et al) and the agent Environment extras now ride each
dispatch — before this, a sprite hermes agent on a non-`custom` provider had
no API key at all on the runner path; and managed pool exhaustion is now
classified from the fatal stderr line, keeping the managed-channel breaker
working where the gateway 503 body used to carry the signal.

One accepted behaviour change: hermes now holds the conversation state in its
own sessions (created via `session/new` / resumed via `session/resume`)
instead of receiving a truncated 30-message history each turn. An existing
session's first post-upgrade turn starts a fresh hermes session, so hermes
will not remember the pre-upgrade conversation; the history stays visible in
Manyfold. `HERMES_HISTORY_BUDGET` leaves `@manyfold/shared` with the stateless
path that read it.
