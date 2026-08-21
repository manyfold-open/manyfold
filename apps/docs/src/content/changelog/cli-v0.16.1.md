---
version: '0.16.1'
date: '2026-07-03'
---

## CLI 0.16.1 — Long-running agent turns no longer drop

Long-running chat and delegated (A2A) agent turns are now resilient to brief network interruptions between your session and the agent's sandbox.

### Highlights

- **No more mid-turn drops.** A transient connection blip no longer kills an in-progress agent turn — work that was running keeps running and reconnects instead of dying 10 seconds later.
- **Cancel still stays prompt.** When you intentionally cancel a turn or it hits its timeout, it now stops immediately rather than lingering.
- **Clearer async guidance.** `mf agent help` now documents that `--async` delegated turns are not unbounded — they still have a cap, just a longer one than blocking turns.
