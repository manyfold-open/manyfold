---
'@manyfold/web': patch
---

Take radius and font stacks from `@manyfold/tokens`.

The radius scale was written down three times (the webapp's Tailwind config,
the docs `--radius-*`, the landing `--lp-r-*`) and the font stacks three
times, with nothing comparing them. `tailwind.config.ts` now imports both
from the package, so those two can no longer disagree at all, and the gate
asserts it keeps importing rather than comparing values that cannot differ.
The stylesheet baselines that cannot import JS are still value-checked.

The product and landing radius scales still diverge at `sm` and `md` — that
is deliberate (DESIGN.md §6.1) and is now declared as two named scales
instead of two unrelated lists. Compiled output is unchanged: `rounded-md`
is still 14px, `rounded-sm` 10px, `rounded-pill` 9999px.
