---
'@manyfold/api': minor
'@manyfold/web': minor
---

An open chat page no longer keeps waking its sleeping sandbox. Before, each wake made the page sync the session's transcript again once the sandbox fell back asleep, and every sync woke the sandbox, so a page left open held the sandbox awake. That counted as active time, even in a hidden tab.

The page now syncs once per opened session. `POST /api/agents/:id/runtime-sessions/sync` leaves a sandbox that is asleep, or whose daemon is not connected, untouched, and answers `skipped: 'asleep'`. Sending a message still wakes the sandbox as before.
