---
'@manyfold/api': patch
'@manyfold/admin': patch
---

Record user-cancelled chat turns as a terminal cancelled outcome and show them neutrally in Admin session summaries, turn tables, and transcripts. Keep genuine historical failures in the Has errors filter while preserving raw cancellation events for inspection.
