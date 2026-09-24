---
'@manyfold/api': patch
'@manyfold/web': patch
---

Agents that run on their CLI's own sign-in (Local config) on a sandbox now
resume a conversation in the terminal and in herdr on that sign-in. The
terminal used to require the platform model credentials instead — which such
an agent does not have — and fell back to a plain shell. A Local-config turn
on a sandbox runtime whose first agent never bound a provider no longer fails
for want of a stored credential either. And a Gemini CLI agent added to an
existing self-owned computer with a Cloud provider now runs on that provider
instead of the computer's own sign-in.
