---
version: "0.31.1"
date: "2026-09-08"
---

`mf channels create` can now create an iMessage channel.

- **`--provider imessage`.** The provider list accepts `imessage`, so an iMessage
  channel can be created from the CLI the same way as any other. Apple publishes
  no iMessage API, so the channel talks to a BlueBubbles server you run on your
  own Mac: pass its URL and server password as the credentials, then run
  `mf channels register` to read the server's version and install the inbound
  webhook automatically.

No other command, flag or output changed in this release.
