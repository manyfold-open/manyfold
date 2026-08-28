---
version: "0.25.0"
date: "2026-08-28"
---

The daemon now reports enough about your local sign-ins for the platform to
tell a working one from an expired one, and `mf model-config update --model`
stops discarding the model you pass it.

- **`model.inspect` reports credential facts, not a guess.** The daemon used to
  answer "are these credentials usable?" by checking whether a config directory
  existed — a readable `~/.claude` counted as a working login, an `auth.json`
  that could not be parsed counted, and `oauth_creds.json` was opened without
  anyone reading the `expiry_date` inside it. It now reports what it found:
  whether a token is present, when it expires, whether a refresh token can renew
  it, and which third-party gateways `~/.codex/config.toml` configures. The
  values themselves never leave your machine — only presence flags, timestamps,
  and the *name* of a provider's environment variable.

- **An expired sign-in is now reported instead of failing mid-turn.** Because
  the facts carry timestamps, the platform re-derives validity against the
  current time rather than trusting a snapshot. A sign-in that has lapsed with
  no way to renew is surfaced before a message is sent, and signing in again on
  the machine clears it — the check re-runs before it refuses.

- **Nothing is judged that cannot be judged.** A macOS host keeps its Claude
  token in the keychain, which a background daemon must not prompt for, so that
  case stays permissive and unchanged. So does any daemon older than this
  release: it reports no facts and keeps working exactly as before.

- **Fixed: `mf model-config update --model <name>` set the model.** For an agent
  using its local config it reported success and then dropped the value, so the
  agent kept running whatever it ran before. The same fix reaches `/model
  <name>` in a connected channel.

- **`mf model-config get` shows the models your CLI actually reported**, which
  is what the web composer now offers as a picker for agents on the local-config
  source.

Existing daemons keep working unchanged; `mf update` pulls the new binary.
