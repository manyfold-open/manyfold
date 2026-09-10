---
'@manyfold/api': patch
'@manyfold/web': patch
---

Managing added accounts on a sandbox runtime now wakes the sandbox and its runner instead of timing out against a frozen one. Adding, signing in, signing out and removing an account resume a sleeping sandbox on the user's behalf; a runtime whose sandbox has never run a turn, or whose runner is not answering, shows a "Start runner" action on the runtime page instead of a dead-end notice.
