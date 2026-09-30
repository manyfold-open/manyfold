---
'@manyfold/api': minor
'@manyfold/web': minor
---

A sandbox that failed to start can be retried in place, instead of being deleted and built again under a new name:

- `POST /sandboxes/:id/retry` builds a failed sandbox again in its own row: same id and name, a new machine. It is admitted under the owner's plan like a new sandbox (a failed one holds no slot), answers 409 `SANDBOX_NOT_FAILED` for a sandbox in any other state and, like a create, 503 `SANDBOX_API_UNREACHABLE` before anything is made when no sandbox could reach this API. A build that fails again leaves the sandbox failed with the new reason.
- Settings › Runtimes offers Retry on a failed sandbox.
- Creating an agent: when the new sandbox built in step ② fails to start, the button retries that sandbox rather than building another. In the classic form, a failed sandbox's card offers Retry and no longer lists checks or installs for a machine that does not exist.
