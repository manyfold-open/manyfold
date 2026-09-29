---
version: '5.5.0'
date: '2026-09-29'
---

`mf login --print-auth-url` signs in without an interactive terminal: it
prints the sign-in URL and exits, and `mf login --auth-code <code>`
completes the sign-in once you approve it. Nothing is stored in between. A
daemon that is waiting for its current work to finish before it updates now
keeps its first deadline, so asking it to update again no longer puts the
update off.
