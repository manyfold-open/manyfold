---
'@manyfold/web': patch
---

The landing's popular pricing tier is marked by its tag alone.

The Plus card also carried a 1.5px iris ring inset over its shadow, which put
two markers on one tier and made the card itself look selected next to the
three plain ones — on a page where the signed-in cards already use a badge to
say which plan is current. The ring is gone and every card now renders the same
frame; the POPULAR tag is the whole signal.

Its `.lp-price-badge.lp-price-popular` rule went with it: `--lp-terracotta`,
which the base badge paints with, has been an alias of `--lp-info` since the
palette consolidated, so the override resolved to the colour it was already
painting.
