---
'@manyfold/api': minor
---

A cloud computer's Manyfold CLI now updates itself when something needs a newer one. Installing a service framework (OpenClaw, Hermes) on a computer whose CLI predates services updates the CLI first, and a computer whose daemon is below the supported floor is updated before its turns run. When there is no newer CLI to install, creating the agent fails right away with `POD_HOST_DAEMON_TOO_OLD` and a message that says so, instead of a generic install failure after the install has run.
