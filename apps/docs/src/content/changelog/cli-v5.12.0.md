---
version: '5.12.0'
date: '2026-10-08'
---

A Hermes or OpenClaw turn no longer fails with "produced no output" the
moment its sandbox wakes from a pause.

The daemon's inactivity budgets now count only the time the machine was
running. A turn whose sandbox slept mid-run keeps its whole budget after the
sandbox wakes, instead of finding it already spent by the pause.
