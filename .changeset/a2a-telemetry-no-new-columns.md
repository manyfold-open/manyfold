---
'@manyfold/api': patch
---

The A2A turn events no longer bring attribute names the log store does not have, which made it refuse every batch that carried one. `a2a.turn.complete`, `a2a.turn.timeout` and `a2a.turn.error` drop `handedOver` (`a2a.turn.handover` records the handover by `taskId`), and `a2a.turn.handover` reports the cap it reached as `timeoutMs` instead of `blockingMs`, `asyncMs` and `remainingMs`.
