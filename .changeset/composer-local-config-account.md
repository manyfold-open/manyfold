---
'@manyfold/web': patch
---

The chat composer's Local config panel now shows and switches the account the agent runs under, reusing the runtime page's account probe. Picking an account persists immediately (same compare-and-set binding as Agent Settings) and takes effect from the next run; while the agent is on the host sign-in, the panel charts that account's usage windows when the last probe has them. The read-only CLI version and Checked rows are gone.
