---
'@manyfold/web': patch
---

Fix the concurrency meter's releasing state, which rendered no colour at all.

Two `className` template literals in `ConcurrencyIndicator` put one
interpolation straight after another with no separator, so the two class names
fused into one that matches nothing:

- a bar belonging to a releasing sandbox emitted
  `h-2 flex-1 rounded-[3px] bg-successanimate-pulse opacity-60` — losing both
  its fill colour and the pulse, leaving an apparently empty bar at 60%
  opacity;
- the chip emitted `… bg-success-bg text-successanimate-pulse` whenever
  anything was releasing — keeping its background but losing its text colour
  and the pulse.

Both now separate the interpolations with a literal space. The space
deliberately does not live inside the ternary branch: `prettier-plugin-tailwindcss`
trims a leading space out of a plain string in that position, which is how the
admin chat-session page's selected-row highlight had been broken by the same
mechanism.

Found by sweeping every class-string template literal in the repo for an
interpolation adjacent to class text — 62 such templates in `apps/web`, 13 in
`apps/admin`, 4 in `apps/web-cloud`; these two were the only remaining defects.
