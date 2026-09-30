---
'@manyfold/api': minor
'@manyfold/web': minor
---

A sandbox whose runner could not connect says why:

- When a new sandbox's `mf daemon register` fails, `SANDBOX_RUNNER_NOT_CONNECTED` carries what the CLI printed, in its message and in `details.registerFailure`. That message is also the reason the failed sandbox keeps, so Settings › Runtimes shows it.
- The web explains `SANDBOX_RUNNER_NOT_CONNECTED` and `SANDBOX_API_UNREACHABLE` in the user's language and names the address the sandbox had to reach, where it used to show the server's English text.
