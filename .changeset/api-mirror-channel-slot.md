---
'@manyfold/api': minor
---

A managed channel mirror (a channel binding that a service framework owns, shown in Manyfold) no longer takes one of the plan's channel slots, as the channel docs already said. Creating a channel now counts only the user's own channels, and so does the channel usage and quota warning the web app shows. Before, mirrors could fill a Free plan's two slots and block every channel of the user's own.
