This project uses a design system defined in @DESIGN.md. Always refer to this file when generating or modifying any UI component

The landing page (`.landing-root` / `.lp-*`) is a separate register with its own
self-contained spec: @DESIGN.landing.md. Use that one — not DESIGN.md — for
anything inside `.landing-root`, and for the Fieldwork ASCII field components in
`src/components/field/`.

The two registers share one brand — the Ash neutral curve, the Iris ramp and the
Source Serif 4 display face are the same on both sides — and differ on purpose
in density: radius, type scale and shadow weight. DESIGN.md §4–§6 says where and
why. Change a shared value in both `styles.css` blocks and in
`apps/docs/src/styles/global.css` together; there is no generator.
