---
'@manyfold/web': minor
---

The landing page is now one scrolled explanation instead of a hero plus five
sections that each restated the product from a different angle.

The old page opened on a floor of roaming agent standees that could fold away
to reveal a second, classic hero behind it, and then said the same thing four
more times: Flow ("three steps to a working agent"), Machines ("run your
workspace anywhere"), Features ("automations, integrations, connective
tissue"), each with its own illustrated apparatus. Everything above the pricing
table was an argument about what Manyfold is, made three ways, none of which
showed how the parts sit together.

The hero is now a pinned stage the reader scrolls through. One isometric world
holds the whole product in three stacked planes — agent infrastructure on top,
the Manyfold control plane in the middle, delivery surfaces at the bottom — and
the camera pans and zooms to the plane each scene is describing while the copy
rail cross-fades beside it. Five scenes: the claim, hosting, one workspace,
every surface, and the point. Below the stage, "Works with" lists what actually
plugs in (frameworks, channels, runtimes) as three rows of chips rather than
prose, and a new metering section shows a per-turn usage ledger next to the
three things it buys you — visible, choosable, capped — with an honest note
that we do not claim the cheapest run every time.

Pricing, FAQ and the closing CTA keep their existing treatment; the Plus tier
now carries the POPULAR badge the grid always implied, and the FAQ answers the
five questions someone weighing this against building it themselves actually
asks.

The stage sits on the page's own grid rather than floating over the viewport:
the copy starts on the same left edge as every section below it, and the world
occupies a column inside the container instead of being shoved against the
right edge by its aspect ratio. The drawing's viewBox was also trimmed to its
own ink — a quarter of its width was empty space on the right, which had been
holding the illustration away from the words. Section headings drop from 76px
to 54px so they sit under the 62px hero title instead of above it.

Copy notes: the hero's four keys are the ones the OG card renders, so the card
is a still of the new hero and has been re-rendered. Chinese sets solid, so zh
gets `word-break: keep-all` and its own step down the heading ramp — without
it the browser was breaking 成倍放大 across two lines in the 46%-wide rail.

Removed with the old page: `ProductDemo`, the workspace-floor hero, and about
2,900 lines of the CSS that drew them.
