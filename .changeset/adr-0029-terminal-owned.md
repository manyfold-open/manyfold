---
'@manyfold/cli': minor
'@manyfold/api': minor
'@manyfold/web': patch
---

Terminals on daemon agents now belong to the daemon rather than to the browser tab showing them (ADR-0029 §6). The daemon keeps the shell and a headless copy of its screen when the tab's connection drops or the tab closes; the workbench's reconnect, or the next open of a terminal for a session that shell holds, attaches to the same shell and gets the screen back, taking it over from any other tab (which is told with close code 4409). A terminal nobody is attached to is closed after 30 minutes, or 5 minutes under a runtime auth profile; "Back to web" ends it at once. The daemon lists the terminals it owns in every hello and heartbeat, and the platform now takes that list, not the tab's tunnel, as proof that a terminal's hold is alive: a terminal the daemon no longer reports has its row ended and its hold released, and a terminal no row claims is closed. `mf daemon status` shows the terminals kept and attached; a daemon keeps at most 8. Daemons without the capability (`pty.terminal.v1`) keep the previous stream-bound behaviour.
