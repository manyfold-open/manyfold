---
'@manyfold/web': minor
'@manyfold/api': minor
---

The Agent sessions panel loads progressively and stays fast with many sessions. Cloud sessions show at once — each with its title, newest reply and model straight from the database — while the runtime is scanned in the background; reopening the panel shows the last list immediately and refreshes it, and "Show more" reaches runtime sessions older than the newest 25. The panel no longer closes when you switch sessions, only when you switch agents.

On the runtime, the scan now takes one index of every transcript and reads only the files that changed since the last scan, instead of forking a process per file and re-reading the newest fifty every time; Claude Code subagent transcripts, which duplicated their parent session, are left out. The `runtime-sessions/list` API accepts `local: 'skip'` and `localLimit`, and reports `localTotal` / `localListed` with `localScan: 'skipped'` when the runtime was not asked.
