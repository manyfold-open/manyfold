---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

Local config is now checked before it is trusted, and you can pick a model from
it.

The "Local config" model source used to treat the presence of a config
directory as proof of a working login. Claude Code needed only `~/.claude` to
exist; Codex accepted an `auth.json` it could not even parse; Gemini read
`oauth_creds.json` without ever looking at the `expiry_date` inside it. On top
of that the source skipped model validation entirely, so a signed-out machine
advertised itself as ready and the failure only surfaced when a message was
already on its way.

Both inspect paths now report what they actually found — whether a token is
present, when it expires, whether a refresh token can renew it, which
third-party gateways `~/.codex/config.toml` configures — and the verdict is
computed from those facts. Because the facts carry timestamps rather than a
yes/no, a snapshot taken an hour ago stops claiming a live token without
needing to be re-inspected. A sign-in that has expired with no way to renew is
now reported in the composer and refused at send time; the refusal re-inspects
the runtime first, so signing in again on that machine is enough to clear it.

Two situations deliberately stay permissive. A daemon older than this change
reports no facts, and a macOS host keeps its Claude token in the keychain,
which a background daemon must not prompt for — neither can be judged, so
both keep working exactly as before.

Picking a model under "Local config" works now. The models your CLI reported
are listed in the composer, alongside Claude's effort and Codex's speed and
reasoning level, each with a "CLI default" entry that hands the decision back
to the local CLI. Nothing is filled in on your behalf: a knob you never set
sends no flag at all. `/model` in a channel and `mf model-config update
--model` set the model too — until now they reported success and silently
discarded it.

The concrete model id you pick is passed through as-is. The hosted path maps a
version onto its family alias (`claude-sonnet-4-5` became `--model sonnet`)
because it repoints that alias through the environment; a local CLI has no
such indirection, so an agent whose stored model was a full id now runs that
exact version.

Also fixes the sandbox copy of the inspector, where an over-escaped pattern
made `requires_openai_auth = true` unmatchable, letting a hosted runtime treat
`OPENAI_API_KEY` as usable even when the local config required a ChatGPT
sign-in.
