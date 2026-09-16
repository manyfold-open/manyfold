---
'@manyfold/api': patch
---

Keep a bounded reconciliation retry when an overlapping daemon hello reports a resumable Chat stream but its open-turn lookup fails. Recovery re-reads the open turn and uses the latest hello's exact ref without requiring another reconnect.
