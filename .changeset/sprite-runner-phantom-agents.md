---
'@manyfold/api': patch
---

Stop sprite-runner sandboxes from minting a phantom duplicate agent, and remove the runner host when its sandbox is deleted. A sandbox VM runs a platform daemon (a "sprite-runner") to dispatch coding-agent turns; it was registering a daemon runtime for every framework it detected — including openclaw/hermes, whose real runtime is the sandbox one — and reconcile then adopted the framework's built-in `main`/`default` profile on it as a second, undeletable agent that the runtimes list hides. A sprite-runner now carries coding-framework runtimes only. Separately, the runner host hangs off `daemon_id` (not the sandbox's `host_id`), so deleting or reaping the sandbox left it and its runtimes stranded; sandbox teardown now removes the runner together with the VM.
