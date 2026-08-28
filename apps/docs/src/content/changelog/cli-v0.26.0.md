---
version: "0.26.0"
date: "2026-08-28"
---

The legacy device-code grant flow is gone. `mf login` is now only about
authenticating your machine; capabilities live where they moved months ago.

- **Removed: `mf login --poll`** and everything that existed for it — `--wait`,
  `--scopes`, `--for-agent`, `--limit-to-agent` and `--resume`. The flow minted
  agent-scoped tokens through a device code you pasted into the browser; it was
  superseded by `mf auth ensure --scopes <list>`, which requests exactly the
  missing capability for the agent and sends its owner a consent link. Every
  message the old flow printed has pointed there for a while.

- **Older binaries get an answer, not an outage.** A pre-0.26 `mf login --poll`
  still reaches the API and is refused with the fix in hand: run `mf update`,
  then `mf auth ensure --scopes <list>`. Tokens the old flow already minted
  keep working unchanged until they expire.

- **The pending-login file retires with the flow.** Poll-mode logins used to
  persist a pending request so the next `mf` command could redeem an approval
  after the process died; nothing writes that file anymore, and the automatic
  redemption that ran before every command is gone with it. A login pending
  across this upgrade (they live 15 minutes) is not redeemable — run `mf login`
  again. The upgrade also cleans up any leftover pending file on your machine
  the next time you log in.

`mf update` pulls the new binary.
