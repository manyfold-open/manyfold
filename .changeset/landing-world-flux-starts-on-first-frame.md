---
'@manyfold/web': patch
---

Start the landing world's light on the first frame instead of on the load event.

The packets that travel the wires were SMIL — `animateMotion` plus `animate`
and `animateTransform` — and Blink does not start an inline SVG's SMIL time
container until the document's `load` event fires. On a cold refresh of `/`
the world was drawn, the wires were lit and nothing moved along them until the
last subresource had arrived, which is exactly the moment the illustration is
supposed to be explaining itself.

Measured on Chrome 148 [2026-09-08], with one artificial 3s subresource
holding the load event open: the drawing was in the DOM at 241ms and
`svg.getCurrentTime()` still read 0 at 3211ms. No API starts that clock early
— `setCurrentTime(0)`, `setCurrentTime(0.001)`, `unpauseAnimations()` and a
`pauseAnimations()`/`unpauseAnimations()` pair all leave it at zero.

A packet now travels on a CSS motion path (`offset-path` + `offset-distance`,
`offset-rotate: auto` for the tail), and its fade and pop are CSS animations
too, all of which run from the first frame the element is styled. The same
holds after the swap: the world moves 59px of packet travel before the load
event in Chrome 148, Firefox 150 and WebKit 26.4, while `getCurrentTime()` is
still reading 0.

Nothing about the choreography changes. SMIL's `values` and `keyTimes` carry
over as a per-packet `linear()` easing over keyframes that run a plain 0 → 1,
so each stop in the CSS is the value the SMIL attribute named, and the wire
paths, clocks and offsets are the same constants as before. Sampled at 104
phases across all 11 packets against the SMIL positions they replace: beads
land within 0.0002 user units in Chrome, 0.61 in Firefox and WebKit (a
difference in how each engine measures arc length — under half a CSS pixel at
the size the world is drawn), tails point within 0.25°, and the scale and
opacity curves match to five decimal places.

`prefers-reduced-motion: reduce` keeps removing the moving parts rather than
stilling them, and the frame it leaves behind is unchanged. The reasoning
behind that rule is not: a packet is now stoppable, so it is removed because a
stopped one is still drawn — parked at the head of its wire — and, measured on
Chrome 148, an invisible packet left in the paint tree shifts the antialiasing
along the wires even when it is moved off the canvas. A ring is still SMIL,
which CSS cannot stop at all.
