---
'@manyfold/web': patch
---

Take type tracking, line-heights and the heading weight cap from
`@manyfold/tokens`.

The two type ramps are meant to differ — the webapp is a workbench with a
compressed head scale, docs is article-shaped — so the sizes stay two
columns. What was shared and unchecked is everything that is not a size:
measured across both baselines, tracking already agreed on all five rungs
and line-height agreed on every rung below the headings. Those are declared
once now, and `tailwind.config.ts` reads them.

The gate also records that docs ships 600 on h1–h4 while DESIGN.md §5 caps
product surfaces at 500. Held at 600 for now — dropping it changes every
heading on the docs site — and listed by `pnpm tokens:drift`.

Compiled output is unchanged: `text-display` is still line-height 1.15,
tracking -0.025em, weight 500.
