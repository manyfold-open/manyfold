---
'@manyfold/cli': minor
---

A skill written on this machine goes into your library in one step. `mf skills library publish ./my-skill` packs the folder (its `SKILL.md` and the files next to it), creates the library skill, or updates the one of that name in place, and pushes it to the agents that have it installed. `mf skills library import --file` takes a folder too, where a folder crashed it with `EISDIR`, and says what it takes when given another kind of file. `mf skills library create` takes the skill's name from its SKILL.md frontmatter when `--name` is left out. A delete refused because agents have the skill names them and `--force`, and counts read `1 file, on 1 agent`, not `1 files, on 1 agent(s)`.
