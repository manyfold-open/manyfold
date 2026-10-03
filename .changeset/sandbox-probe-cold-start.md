---
'@manyfold/api': minor
---

A sandbox whose commands were once refused ("not accepting commands") is no longer kept out just because it is asleep. The check that decides whether it recovered now gives a sleeping sandbox time to start, up to 45 s (`MF_SPRITE_EXEC_COLD_PROBE_TIMEOUT_MS`), instead of 5 s, which a cold start never fits in. Before, a sandbox that only scheduled runs reached stayed refused on every run: each check met it cold, timed out and refused it again.
