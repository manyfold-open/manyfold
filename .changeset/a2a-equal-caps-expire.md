---
'@manyfold/api': minor
---

With the A2A blocking and async caps saved equal, a send that reaches the blocking cap now always fails its task right there, as intended. Before, a busy server could read the clock a few milliseconds short of the cap, answer `working` and hand the task over, and then fail it moments later.
