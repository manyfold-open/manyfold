---
'@manyfold/web': patch
---

Let heading tracking come from the rung.

Every heading rung carries its own letter-spacing in the `fontSize` tuple —
h3 −0.01em, h2 −0.015em, h1 −0.02em, display −0.025em — because tracking has
to tighten as size grows and the tuple is the one place that knows the size.
34 headings then stacked `tracking-tight` on top of that. Both write
`letter-spacing`, and Tailwind emits the `tracking-*` utilities after the
`text-*` ones, so the utility won: an 18px panel title rendered at −0.025em,
the tightening reserved for 32px display copy, roughly a quarter-pixel per
letter too tight and a few pixels narrower over a title.

It read as inconsistency rather than as a bug — some titles tightened, some
not, depending on which page you were on. Removing the utility puts every
heading back on its rung's own value; nothing else changes.

`.settings-stat-value` had the same stack and is fixed with them. The one
`tracking-tight` that stays is on a mono caption in the chat footer, which is
not a heading rung — tightening a mono run there is a deliberate choice.
