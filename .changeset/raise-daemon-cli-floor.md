---
'@manyfold/api': minor
'@manyfold/cli': minor
---

Daemons now need Manyfold CLI 4.6.1 or newer, the release that carries the scoped storage reports, Pi's session home, services on cloud computers and Hermes turns that no longer stall at startup. The API refuses registration, heartbeats and connections from an older daemon, and `mf doctor` and the daemon's refusal message name the new minimum.

A daemon started by launchd or systemd against the official API updates itself within about six hours once it is idle. A daemon started by hand, or one pointed at a self-hosted API with auto-update off, stays refused until `mf update` runs and the daemon restarts. Sprite runners and cloud computers below the minimum are reinstalled when they are next used, and the cloud computer image now starts with CLI 4.6.1, so a new cloud computer registers straight away.
