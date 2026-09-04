---
'@manyfold/web': minor
---

Take the weight out of a model row: a checkbox instead of a switch, and one
price-source line instead of a tag per row.

A provider can list 184 models, and the row's two loudest marks were both
saying something a reader already knew. A **switch** is a ~36×20 filled pill
— the heaviest control in the design system — repeated once per row, which
made the list read as 184 independent settings rather than one membership
list, and put more ink on screen than the `Save` button that actually commits
them. It becomes a **16px checkbox**: `--color-link` fill + check when on, a
ring-only box when off. That is the §8.12 selection language spelled with the
control multi-select actually calls for, and 16px at the radius ladder's Xs-8
floor is what §6.1 reserves that tier for — "a glyph, not a surface."

The **price-scope tag** was on all 184 rows with the same word on every one
(`NetMind`, or `Platform` for a provider on built-in prices). A tag whose
value never varies is a column of noise, so it lifts into one footer line —
`Prices from NetMind` — and stays on the rows that **deviate**: `Custom`
where the user pinned a price, `No price` where none resolved, `Platform`
where one model falls back. Those are precisely the rows worth marking, and
they now stand out instead of hiding among 180 identical neighbours.

`dominantScopeTag` takes the **majority**, not unanimity. Unanimity never
fires on real data — a provider's price map does not cover every model it
lists, and one `No price` row would put the tag back on the other 183. The
footer claims what most rows are; the minority keeps its own tag, so no row
is ever mislabelled by omission.

The `↗` glyph is gone too. On a static (managed) row the source link now
wraps the price itself, so following it is one target rather than an arrow
repeated 184 times next to the number you came to read.

Deliberately **not** in here: the rail's `CreateMenu variant='footer'` and
`GroupByControl`, which carry the same excess weight but are shared by three
and six pages respectively. De-weighting them is a cross-page change with its
own blast radius, not a rider on a model-list PR.
