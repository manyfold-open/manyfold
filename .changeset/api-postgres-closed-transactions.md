---
'@manyfold/api': patch
---

A Postgres connection that closes while a transaction is using it no longer crashes the API. Before, the automatic rollback was written to the closed socket and threw an uncaught `TypeError`. Queries still queued in that transaction stayed pending forever. A transaction callback that kept running could also query, commit or roll back whichever transaction reused the connection next. The bundled postgres.js 3.4.9 is now patched with the upstream fix ([porsager/postgres#1215](https://github.com/porsager/postgres/pull/1215)): the transaction's own queries, including its rollback or commit, reject with `CONNECTION_CLOSED`, and the reconnected connection starts clean.
