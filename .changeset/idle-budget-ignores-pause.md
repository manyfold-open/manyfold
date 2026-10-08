---
'@manyfold/cli': minor
---

A Hermes or OpenClaw turn no longer fails with "produced no output" the moment its sandbox wakes from a pause. The daemon's inactivity budgets now count only time the machine was running, so a turn whose sandbox slept mid-run keeps the whole budget after it wakes.
