---
'@manyfold/web': patch
---

The channels rail opens as a plain list, without the search box and status
chips.

Settings -> Channels opened grouped by platform, under a search field and a
row of All / Active / Issues chips — three separate filters stacked over a
list that is usually short enough to read at a glance. Group by now offers
None and defaults to it: the rail shows every channel flat, most recently
updated first, each row carrying its platform and its agent. Platform, Agent
and Status grouping are unchanged and still one click away, and grouping by
status still gathers the paused and errored channels together. The agent
filter that other pages link into (Agent settings -> Channels) is untouched.

The rail remembers its grouping per device, so the store key moved to v2:
browsers that had already chosen a grouping here start again on None.
