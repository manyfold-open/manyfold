---
---

Test-only: the API-token expiry label test asserted the rendered year, which is a statement about the runner's timezone rather than about the code. `2027-01-01T00:00:00Z` renders as `12/31/2026` anywhere west of UTC, so the test passed on GitHub-hosted runners and failed on the self-hosted ones the private superproject uses. It now asserts what the fix was actually about — a future expiry renders as a date instead of the em-dash placeholder — and was checked green in UTC, `America/Los_Angeles` and `Pacific/Kiritimati`, and red in all three against the old behaviour. No user-visible change.
