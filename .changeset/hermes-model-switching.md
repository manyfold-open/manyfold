---
'@manyfold/api': minor
'@manyfold/cli': minor
'@manyfold/web': minor
---

Hermes chats can switch models per message. The composer's model menu now works for hermes agents (options come from the agent's provider-models cache, which the model-config view serves for hermes too, with a filter box once the list grows past a screenful), and the choice is applied via ACP `session/set_model` — hermes persists a session's model in its own state.db, so env vars cannot move a resumed session. Every transport reconciles by diffing against the models state hermes reports on session/new|resume: an untouched session costs no RPC, and picking "Default" re-sends the default's id because a hermes session would otherwise keep the previous pick under a UI that claims otherwise. Daemon-carried turns gate on the new `turn.hermes.options` capability: an explicit switch on an older daemon is refused with `hermes_daemon_options_upgrade_required` (never silently dropped), while the auto-defaulted value skips quietly; a hermes build that predates `session/set_model` fails an explicit switch as `hermes_set_model_unsupported`. The daemon reports the session's models/modes state on the turn final, captured best-effort into `agents.extras.hermesAcp` for diagnostics.
