---
'@manyfold/web': minor
---

Move the resource meters to the foot of the rail.

The concurrency chip hung from the Agents section header, and that header is
not rendered at all when the rail is collapsed — so the one indicator telling
you whether another sandbox can start disappeared exactly when the rail was
narrow enough that you might want to check it without expanding anything.

It now sits in its own strip above the account row, which is where the question
it answers lives: not "what about these agents" but "how much of this account
is left". Collapsed, the chip keeps its tone and drops its numbers — 58px
cannot hold `0/10`, and a glyph that still reads red is worth more than no
glyph at all. The count comes back in the tooltip and in the panel.

The panel it opens now picks its side. It always dropped downward, which was
fine when the chip hung from a section header near the top of the rail and is
not fine at the foot of it — measured at a 950px window with no sandboxes
running, 140px of the panel fell below the fold, and the list inside it grows
by up to another 256px. It opens below when it fits there, flips above when it
does not, and is capped to whichever side it lands on so a long list scrolls
instead of running off the screen.

One editions extension point ships alongside it, contributing nothing in this
build and changing no layout: `src/shell-extra.tsx` names two regions of the
shell — the new meter strip and the shell root — that a distribution can mount
into by shadowing the module at its path. Regions, not features: this app does
not know what a distribution puts there.

`SidebarSectionHeader`'s `meta` slot is removed along with the move: it had
exactly one caller, and an unused extension point on a header that collapses
out of view is an invitation to repeat the bug.
