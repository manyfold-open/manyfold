---
'@manyfold/web': patch
---

Stop the landing world's mesh dots under `prefers-reduced-motion: reduce`, and
start them on the first frame rather than on the load event.

Three dots hand a light along the leads of the control plane's mesh. They were
SMIL — an `animate` on `opacity` and one each on `cx` and `cy` — and they
carried no class, so the reduced-motion block, which stills every CSS animation
in the world and then removes the flux by class name, had nothing to catch
them: they went on animating. `DESIGN.landing.md` §6.3 lists three things
allowed to move on the landing page and says reduced motion freezes or removes
the rest, and these were the last unhandled mover in the drawing.

They were also why a reduced-motion screenshot of `svg.lp-world` was not
reproducible. Measured on Chrome 148 [2026-09-08]: six frames of the world
taken 420ms apart differed from one another by 216–313 subpixels, every one of
them inside the mesh's own 45×22px box. The same six frames now differ by none,
which is what makes the world pixel-comparable in that mode at all.

The travel is now a CSS `transform: translate()` off the node a dot is drawn
on and the fade a CSS `opacity` animation, which also fixes the cold-refresh
defect [#239](https://github.com/manyfold-open/manyfold/pull/239) describes for
the flux packets: an inline SVG's SMIL clock does not start until the
document's load event, so a cold refresh of `/` drew the mesh and left nothing
crossing it. Seen on Chrome 148, Firefox 150 and WebKit 26.4 [2026-09-08], with
one 3s subresource holding the load event open: the world was in the DOM inside
500ms and `svg.getCurrentTime()` still read 0 a second later, while the CSS
clock had already run 1.25s and the dot was half way along its lead.

Nothing about the choreography changes. A dot is drawn on its lead's first node
and carries that lead's own delta, so the two keyframes are shared and a dot
differs from its neighbours only by the `animation-delay` that was its SMIL
`begin`. Sampled every 25ms across two full periods — 519 phases over the three
dots, each against the SMIL it replaces, the SMIL clock seeked with
`pauseAnimations()` and `setCurrentTime` and the CSS one with
`animation.currentTime` on the same absolute time — a dot lands within 0.0007
user units of its old position in Chrome, 0.025 in Firefox and 0.00006 in
WebKit, and the opacity curves match exactly bar Chrome's computed-style
rounding. Rasterised rather than merely laid out: the ink centroid of the first
dot, sampled at ten phases across its run, lands within 0.15 CSS px of where
the SMIL dot drew, and both track the analytic point to within a quarter pixel.

Reduced motion removes the dots rather than stilling them, alongside the flux
classes. Stopping them is now possible — `animation: none` leaves an
`opacity='0'` circle parked on a node the mesh already draws, and measured on
Chrome 148 the frame is the same to the subpixel either way — so the rule
removes them in order to say which parts move rather than leave that to a
presentation attribute. That is a weaker reason than the one the same rule
gives for a packet, whose invisible remains do shift the antialiasing along the
wires; the comment there now says so, so that neither argument is carried over
to the other part without being measured again.

One thing the reduced-motion frame buys that a moving one cannot: while
animations run, Chrome's rasterisation of the drawing depends on which elements
carry them. Measured on Chrome 148 [2026-09-08], baking the three dots'
computed transform and opacity into inline style and cancelling their
animations — the identical picture — already moves 4,439 subpixels of
antialiasing elsewhere in the world. A pixel test of this illustration
therefore belongs in reduced motion, where it is now exact.
