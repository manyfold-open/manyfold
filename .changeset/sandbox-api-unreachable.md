---
'@manyfold/api': minor
---

A new sandbox is refused before anything is made when its runner could never call this API back:

- When `PUBLIC_API_BASE_URL` points at an address a sandbox provider's VM cannot open (localhost, a `.local` name, a private or loopback IP, as on a local stack without a tunnel), creating an agent on a new sandbox and `POST /sandboxes` answer 503 `SANDBOX_API_UNREACHABLE` with the address in `details.apiUrl`. No quota slot, sandbox name or VM is spent on it.
- A new sandbox whose runner did not connect answers `SANDBOX_RUNNER_NOT_CONNECTED` (503) and names the address it had to reach, instead of `SANDBOX_DAEMON_OFFLINE` with no reason.
- A `PUBLIC_API_BASE_URL` that already ends in `/api` no longer becomes `/api/api` in the address a sandbox's runner is given.
