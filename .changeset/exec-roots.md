---
'@manyfold/api': minor
'@manyfold/cli': minor
---

A turn now carries the directories it runs in — the agent's workspace and
its framework's home — on the exec itself, instead of registering them with
the daemon in a separate call just before the turn. A message to an agent
whose workspace sits outside the machine's managed tree (a coding agent on
a sandbox it shares with a service framework) no longer depends on that
extra round trip landing before the machine sleeps; the daemon admits the
exec's directory for that exec only. A daemon too old to read them is asked
to update before the turn rather than failing mid-turn.
