---
'@manyfold/api': minor
'@manyfold/web': minor
---

A chat turn the platform stops no longer reads as the user's cancel. When an A2A task's time limit stopped the turn it started, the turn ended `cancelled_by_user`, and the chat showed a silent stop with no reason. It now ends with the error `a2a_turn_timeout` and a message naming the limit that stopped it, and counts as a failure rather than a cancel. A cancel you send yourself still ends `cancelled_by_user`.

The chat explains a turn stopped at a time limit in plain words, keeping the technical message under it. This covers the A2A limit and the turn length limits the platform already enforced, which until now showed only their raw message.
