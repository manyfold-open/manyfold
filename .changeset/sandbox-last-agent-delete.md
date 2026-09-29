---
'@manyfold/api': patch
---

Deleting the last agent on a sandbox runtime works again: the runtime is removed with it and the sandbox is kept for reuse. It answered 409 "runtime still has agents" because the check counted the agent being deleted, and the sandbox then could not be deleted either.
