---
'@manyfold/cli': minor
---

`mf skills install` takes a skill's name: `mf skills install mcp-builder --agent-id agt_…` finds it in your library or the catalog (an exact match, ignoring case, by the skill's name or its folder's) and installs it, saying where it came from; `anthropics/mcp-builder` takes that repo owner's. A name several skills share (the catalog's repos overlap) lists them, by owner and by id, and installs none. Ids work as before, as the argument or as `--skill-id`. `mf skills discover` prints `(no skills found)` for an empty page, where it printed nothing, and names on stderr the repos the API is still reading for the first time. `mf skills list` (and `ls`) is `mf skills installed`.
