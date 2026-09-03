---
'@manyfold/web': minor
---

The chat header carries a Chat / Terminal switch, so a session's terminal is a
full-height view of that session rather than only a dock along the bottom. Both
panes stay mounted: switching back to Chat keeps the reading position, and
switching back to Terminal keeps the shell, its scrollback and its websocket, so
the toggle costs nothing on either side. The terminal segment is refused with a
reason for an external-provider agent (no shell exists to attach to) and for a
stopped one, and a sprites sandbox with the terminal turned off still asks
before enabling it. The bottom dock is unchanged: it remains the place for
several shells at once, for a shell opened at a particular directory from the
file tree, and for one that must outlive the page you opened it on.
