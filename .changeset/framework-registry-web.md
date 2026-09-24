---
'@manyfold/api': patch
'@manyfold/web': minor
'@manyfold/admin': minor
---

The workbench and the admin console now take framework names, logos, create-flow entries and per-framework behaviour from the framework registry rather than from fixed lists, so a framework an edition registers shows up wherever the built-in ones do; on the API side, such a framework's own module registers its definition. The composer's agent picker now names Pi, Dify, Langflow and A2A agents instead of showing a generic "Agent", and the admin's framework default-versions page lists frameworks in registry order under their full names.
