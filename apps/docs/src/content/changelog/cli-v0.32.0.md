---
version: "0.32.0"
date: "2026-09-09"
---

A computer or sandbox can now hold more than one vendor sign-in, and each
agent picks which one it runs under.

- **Added accounts live beside the host sign-in, not on top of it.** From the
  runtime page you can add a second Claude Code, Codex or Gemini CLI account,
  sign it in from a terminal that opens inside that account's own credential
  store, and sign it out or remove it later. The machine's own sign-in is left
  exactly as it was.
- **Switching auth never forks configuration or transcripts.** Each added
  account keeps only its credential files; sessions, history, config and
  codex's state databases stay in the native CLI home, so resuming a session
  works the same whichever account it ran under.
- **Agents run under the account they are bound to.** Chat turns, the agent
  terminal and the model-capability probe all run inside the bound account's
  context, with the machine's ambient vendor keys stripped. Two agents on the
  same account take turns rather than refreshing the same token twice.
- **An older daemon refuses instead of guessing.** A machine that cannot honour
  an agent's account binding — including this CLI's predecessors — declines
  the execution rather than answering with its native sign-in, and the web UI
  points at the update.

No command, flag or output changed in this release; the new behaviour is
advertised to the API as the `auth-profiles.v1` and `auth-context.v1`
capabilities.
