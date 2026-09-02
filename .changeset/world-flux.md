---
'@manyfold/web': patch
---

The landing world's three planes are now joined by light rather than by line.

Every solid in the scene is drawn as a lit body — modelled faces, a silhouette
outline, a contact shadow — but the wires between the planes were flat
hairlines of one uniform alpha with flat discs sliding along them, and the
mismatch is what made the lower half read as unfinished. The connective tissue
now uses the same language as the bodies: each wire is a soft bloom under a
crisp core whose stroke is a gradient fading with distance, so a cable has a
length instead of being a stripe of constant value.

Below the control plane the three trunk strands splay where they leave the
plate and gather into a junction, so the bundle has a round cross-section
instead of reading as a barcode — and all three now carry traffic, where only
the middle one used to. The trunk lands on an actual junction: a puck with a
plinth, a contact shadow, a halo and a ripple that fires on each arrival,
rather than on a bare four-unit dot floating over a plate. The four routes out
of it are curves that stop at a lit pad on each destination plate instead of
straight chords aimed at the object standing on it, which is what used to send
them through the solids they were meant to reach.

One clock now runs the whole chain, so a single run can be followed all the way
down: a packet reaching the junction, the ring it fires there and the route
that leaves are the same run, where the old 3.2s trunk and the fan-out's own
begins were aliased against each other and no two events were ever related.

The packets themselves are lit beads — an aura, a hot core, and a tail that
trails the head however the wire curves — that scale in and out rather than
blinking. Above the control plane they keep their framework's hue, because
what arrives there is a particular framework's run; below it they are the brand
hue, because Manyfold has normalised them. The light is carried by gradients
rather than blur filters, which would be re-rasterised on every camera frame.

Light mode now treats the blue energy as reflected light on paper: the wide
wire bloom, plane spill and control-cube glow are reduced independently, while
dark mode keeps the stronger emissive treatment.

`--lp-w-flux` and `--lp-w-flux-spec` are new: the flux is read against the
world's plates rather than against the page, so on the near-black plate it has
to climb the Iris ramp to hold the same weight, exactly as `--lp-w-wire` does.
SMIL cannot be stopped from CSS, so under `prefers-reduced-motion` the moving
parts are removed and the wires, ports and pads they travel between stay.
