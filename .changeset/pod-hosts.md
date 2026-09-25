---
'@manyfold/api': minor
'@manyfold/web': minor
---

Cloud computers are now generic Kubernetes pod hosts. Each one runs the `manyfold-runtime-host` image with its whole home directory on a persistent volume, and frameworks are installed into it on demand: Claude Code, Codex, Gemini CLI and pi, several on one computer, each at the version a sandbox would get (the admin default, else the latest) and upgradable in place. The computer's own daemon carries every turn, and provider credentials travel with each turn instead of being stored on the computer. A new `/pod-hosts` API lists, creates, renames and deletes cloud computers, installs a framework on one and updates its CLI; the Cloud computers settings page, the agent create flow and the Update Center use it. Files, backups and the terminal reach a cloud computer through pod exec, so nothing on it is published over HTTP. Deployments set `K8S_RUNTIME_IMAGE` to a published host image; the per-framework `K8S_IMAGE_*` settings are no longer read. OpenClaw and Hermes are not offered on cloud computers yet.
