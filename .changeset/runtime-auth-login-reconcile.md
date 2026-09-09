---
'@manyfold/api': patch
---

Closing the sign-in terminal of an added account no longer leaves its login operation stuck as running. The verdict is journaled by the daemon only once the sign-in shell has exited, which is a moment after the terminal socket closes; the close-time reconcile now waits for that verdict, and reading an operation that is still open re-checks the host so a late verdict is picked up by the page's own poll.
