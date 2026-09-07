---
version: "0.30.2"
date: "2026-09-07"
---

`mf channels create` can now create a Google Chat channel.

- **`--provider googlechat`.** The provider list accepts `googlechat`, so a
  Google Chat channel can be created from the CLI the same way as any other.
  Pass the service account JSON key as the credentials, then run
  `mf channels register` to capture the authentication audience and activate
  the channel.

No other command, flag or output changed in this release.
