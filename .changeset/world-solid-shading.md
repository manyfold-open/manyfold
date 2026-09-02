---
'@manyfold/web': patch
---

The landing world's solids now all take the same light in light mode.

Two boxes were reading against the scene's own key light, which falls from the
upper left — tops brightest, left faces a step above right ones. The archive
plane's three cabinets are authored facing the other way and mirrored into
place, and the mirror had been added without swapping their side shading back,
so each one was lit from the right while everything around it was lit from the
left. The delivery cube's top used `--lp-w-box-accent`, the landmark step above
an ordinary top: in dark mode that is a lighter face, but on paper an ordinary
top is already white, so the light value had been stepped the other way and the
landmark rendered as the one grey box in a scene of white ones.

The cabinets swap their two side tokens inside the mirrored group, and the
accent tops out at white where it has nowhere brighter to go. Dark mode is
untouched: its accent still sits a step above its ordinary tops. Checked in
both themes — every left face on the stage is now the lit one, and every box
top matches its neighbours.
