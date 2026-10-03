---
'@manyfold/api': minor
---

An automation run whose sandbox does not come up now asks again instead of failing at once: after one minute, then after three more, within the same run and chat. A cold sandbox that misses one start usually comes up minutes later, so the run still gets its reply and its one delivery. If the sandbox still does not start, the run fails as before, about eight and a half minutes in at worst, and a cancel ends it at once. Messages sent from a chat are unchanged.
