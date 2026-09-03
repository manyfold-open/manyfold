---
'@manyfold/api': patch
---

Active-hours enforcement now holds on a sandbox that is already awake, and says
so when it cannot.

Turns on a running sandbox were admitted through a fast path that skipped the
hours check, on the reasoning that the background sweep would put an over-quota
sandbox to sleep and the next cold start would re-check everything. When the
sweep cannot reach whatever is keeping a sandbox awake that never happens, so an
over-quota sandbox kept accepting work indefinitely — on production, ten times
its included hours. Over-quota users are now refused on that path too, with the
same message and the same relief (a plan change or an hours bonus unblocks them
immediately). Users within their quota see no change, and installations with
enforcement turned off are unaffected.

Stopping a sandbox also no longer reports a clean result when it had nothing it
could act on. A running sandbox with no agents, runtimes, services or tasks
registered on it is being held awake by something out of reach, so the stop
cannot work; that now comes back as a warning, is recorded on the audit entry,
and is logged. The enforcement sweep reports those hosts separately from the
ones it actually put to sleep, so a sandbox it is powerless to stop shows up the
first time instead of after days of apparently successful retries.
