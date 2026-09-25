---
'@manyfold/cli': minor
'@manyfold/web': minor
'@manyfold/api': patch
---

The daemon recognises a new startup method, `container`, set by the boot loop of the pod host runtime image: under it the daemon accepts `daemon.update` and restarts by exiting, while auto-update stays off so the platform decides its version. The self-owned machines page labels it "autostart · container". The new `manyfold-runtime-host` image carries the toolchains and OS packages frameworks need but no framework, for pods that install frameworks on demand; its boot loop keeps the daemon's mf on the pod's volume and falls back to the image's copy when an update will not stay up.
