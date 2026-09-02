---
'@manyfold/web': patch
---

Delay landing World layer annotations until the camera zoom and focus settle,
then fade them in as the active layer comes into view.

Layer names are scoped to their active scene rather than remaining visible in
the global overview, and use the landing display face at a quieter size. The
camera transition leaves a clearer pause before supporting callouts appear.

The Skills & MCP node is now illustrated as a compact isometric toolbox while
keeping its existing annotation anchor aligned.

Screen copy and usage marks now follow the isometric face direction instead of
remaining flat to the viewport.

The usage chart details are nudged inward from the card edge for a cleaner
visual margin.

The complete usage device is inset from the lower plate edge so its base and
screen share the same visual margin.

The control-plane usage device is shifted right within its card to match the
requested alignment.
