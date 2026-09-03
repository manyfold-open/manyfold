---
'@manyfold/api': patch
---

A sandbox no longer stays awake — and no longer bills active hours — because of
an exec session nobody is attached to. sprites.dev keeps a session's process
running after its client socket goes away, so an upload or command that died
mid-stream could leave a process blocked forever, and a live exec session pins
the VM `running`. On production this let one free-plan sandbox accrue 52 hours
against a 5-hour quota over three days: the sandbox had no agents, runtimes,
services or tasks left, so the active-hours enforcement sweep found nothing to
stop and reported success on every pass.

Two changes: a command that ends on the client's terms (timeout, cancellation,
or a request body that failed part-way) now terminates its remote session
instead of only closing the connection, and the sandbox sync loop reaps
sessions on running sandboxes that nothing has touched for six hours — well
clear of the longest permitted chat turn. Reaped sessions are logged and
counted so a sandbox that cannot be put back to sleep is visible instead of
quietly accruing.
