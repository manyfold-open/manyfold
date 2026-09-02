---
'@manyfold/api': patch
---

Take the email palette from `@manyfold/tokens` instead of transcribing it.

Mail clients strip custom properties, so email colours have to be literal
hexes in the markup — which quietly made the palette a fourth hand-maintained
copy of the product ramp, and it had fallen behind on five light-mode values.
The new package owns which product token each field mirrors, holds the values
that still disagree behind a stated reason, and is covered by a test that
pins the rendered hexes. No email renders differently.
