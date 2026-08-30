---
version: "0.28.0"
date: "2026-08-30"
---

Hermes chats grow up: tool outputs render, the model can be switched per
message, and the new permission modes can route approvals to you instead of
auto-approving everything. The daemon advertises two new capabilities —
`turn.hermes.options` and `turn.hermes.permissions` — and the platform
refuses, with a clear upgrade message, to send a model switch or an ask-mode
turn to a daemon that predates them.

- **Interactive permission approval for hermes.** Pick "Ask for approval" or
  "Accept edits" in the chat composer and the agent's permission requests
  appear as cards in the transcript; the daemon holds the turn open while you
  decide, denies safely if nobody answers within the timeout, and records the
  outcome durably so a recovered turn replays it exactly.
- **Per-message model switching for hermes.** The daemon applies the choice
  via ACP `session/set_model` after checking the session's current model, so
  an untouched session costs no extra round trip, and reports the session's
  model/mode state back to the platform.
- **Hermes file edits stop being silently denied.** The headless
  auto-approval now answers with an option the request actually offers;
  current hermes builds only advertise `allow_once`/`deny` on edit approvals,
  and the old hardcoded answer mapped to deny.

Run `mf update` on daemon hosts to pick up the new capabilities — older
daemons keep working for everything except the new model-switch and ask-mode
features, which are refused rather than silently degraded.
