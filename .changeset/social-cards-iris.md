---
'@manyfold/web': minor
---

Repaint the social cards onto the Iris palette.

Both were left behind by the product migration, in two different directions.
The generated card behind changelog entries was still teal (`#0f8c6f`) — the
accent from two brand colours ago. The static poster every other page shares
was still the pre-Iris steel blue, on a ground (`#dde0e3`) darker than the
landing has used since the neutral axis moved. Sharing a link produced a
preview in a colour the page it opened did not contain.

The poster's headline also stopped etching itself. `.lp-h-accent` dropped its
metal gradient when the landing went flat; the poster kept reproducing it,
including a gradient stop (`#d6e0e8`) that belonged to no palette. It now
paints flat `--lp-info`, as the page does.

Cards ship as v4. v3 is frozen into `RETIRED_CARDS`, so a link shared before
this still resolves to the exact bytes it was shared with.

The colours in both cards are still written literally rather than imported —
that is deliberate, so a CSS refactor cannot silently repaint every card that
is already in circulation — but each constant now names the token it mirrors,
which is what was missing when they drifted.
