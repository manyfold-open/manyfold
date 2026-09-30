---
'@manyfold/api': minor
---

A Claude Code turn that continues a session is recorded on the model it ran on and at its own cost. Since Claude Code 2.1.277 a resumed run restores its session's cost ledger, so the cost it reports is the session's running total and its first listed model is the session's first. Manyfold stored those as the turn's: a turn run on Haiku after a switch from Sonnet was recorded as Sonnet at the whole session's cost, and in any longer session every turn's recorded cost grew with the session. The model now comes from the run's own start-up line, and a resumed run is priced from its own tokens at the price table's rates (`costSource: 'table'`; subagent spend, which those tokens leave out, is not included). A session's first turn keeps the cost Claude Code reports. Rows recorded before this change are not corrected.
