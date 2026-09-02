---
'@manyfold/web': patch
---

Every body in the landing world now turns a face of the right width to the
camera, and the agents work behind their desks instead of standing on them.

The world was drawn on a correct 30° isometric grid, but a solid's footprint
decides how wide each of its two visible faces reads: a body 52 deep by 34
wide shows a 52-wide face to the left and a 34-wide face to the right. Nothing
enforced a relationship between those two numbers, so bodies came out sheared.
The desks were the loudest case in a second way — the ones whose screen faced
left stood on their long edge and the ones facing right stood on their short
edge, so the same workstation was 52 wide in one corner of the plane and 32 in
another, wearing a 34-wide monitor in one place and a 16-wide one in another.

Desks are rectangles now, and the long edge is always the one they face the
camera with: the side the screen stands on and the figure works behind. The
pipeline plate follows the same rule for the same reason — the node chain runs
along it, so its long edge faces the camera too. The bodies that genuinely have
no front — plinths, racks, the control-plane cube — are square in plan instead,
which is that rule with no facing to honour; between them that fixed the
terminal plinth at 1.96:1, the pipeline plate at 3.05:1 and the skills base at
2.82:1. Thirteen of them were
rebuilt, with their screens, bars, lamps and leader-line captions carried
along. The ground plates keep their shapes, since a plot of ground is allowed
to be oblong.

The four identical stations, the bring-your-own desk and the two that face the
other way were also nine separate copies of the same drawing. They are now one
`Workstation` built on an isometric helper, where `flip` swaps the two ground
axes to turn a whole station — desk, screen, long edge and figure — without
touching a single proportion.

The figure itself: it used to stand on the desktop, which is not what an agent
at a workstation does. It is now drawn before its desk, so the desk's far edge
cuts it at the waist and it reads as working behind it. Its head was a grey
shell around a stroked inner card around the framework mark, three frames deep;
it is now one blank face with the mark centred in it, a size larger. And it has
an antenna — a stalk and a lamp that breathes green — because nothing in the
world said whether an agent was actually running.

The planes are also positioned with a denser vertical rhythm: the upper plane
is translated down and the lower plane up as complete groups, bringing the
stack together without changing the artwork's proportions. Short desktop
viewports additionally give the hero copy a proportional step down.

The delivery layer is now enlarged uniformly around its junction, with the
fan-out curves and pads following the same coordinates so the larger footprint
stays connected to the control plane.

The top plane is also at work now. Each screen carries a live log: a line wipes
and types back in over five steps, along the screen's own axis rather than
across the drawing — the contents are authored in the face's own frame, so
`scaleX` writes a line out instead of shearing it off the isometric grid. The
run slot on each agent's body breathes with it, and the figure works: it taps
four beats while its line is being written and stands still while the line
stands. At this size a body moving a unit is under the eye's floor, so the read
is carried by the head — a five-degree lean pivoted at the neck, two beats
behind the body so the antenna whips rather than moving with it, which swings
the lamp, the brightest thing on the plane, about three pixels in the hero and
twice that once the camera is on this plane. Three clocks drive all of it —
the log on 4.8s, the active line on 3.1s, the slot on 2.2s, none a multiple of
another — and every station is handed each clock on its own negative delay, so
seven desks never fall into step and none of them waits for a cycle to begin on
load. The antenna lamps were pulsing in unison; they are staggered now too. All
of it is CSS, so the world's existing reduced-motion rule already stops it, and
the state it stops on is every line finished — which is what a screen at rest
should show.

The checklist board on the delivery plane had its tiles authored in screen
coordinates inside a group that already carried the panel's own matrix, so the
lattice was sheared twice and its columns marched across the drawing instead of
along the face. The tiles are laid out in the panel's frame now — an even 4 x 3
grid, one cell running and one ticked — and the tick stays upright, the way
every other legend in the world is drawn.

The delivery plane was four copies of one composition — a plate, a plinth, an
upright panel — so the four surfaces it names read as one thing repeated rather
than as the different places an agent's work actually lands. Each is now shaped
like what it is. The terminal is a machine: a deck lying on the plate with the
screen hinged up from its back edge, keys and a trackpad printed on the deck,
and no plinth at all, which is what breaks the repeated stack. Your product arrives
on a monitor: a cabinet with real thickness, so its top and side edges read as
depth rather than as a poster stood on edge, carried on a column that reaches
the desk, with the machine that drives it standing beside it and desk left in
front of both, and the screen itself is smaller than the panel it
replaces. It wears a window's own chrome, a title bar with three dots and an
address pill. Its plinth follows the desks' rule too — the long edge is the one
the screen faces the camera with.
Team chat gets a speaker slit and a home bar, and the card is a handset. The
schedule board already had its own grid and keeps it.

The terminal's surface was also the only pure black in a near-white world, a
hole in the light theme. It is a light console there now and stays dark in the
dark theme, where dark is what the rest of the world is.

The three surfaces that were still single quads have bodies now, built the same
way as the monitor: a slab four to six units thick, so the lid and the side
edge do the work a drop shadow would otherwise have to. Team chat is a phone —
a bezel around an inset display, standing in a dock. The schedule and the usage
readout are boards standing in base rails, one carrying a month header over a
day grid, the other a bar chart on a baseline. A panel with no thickness reads
as a sheet of paper propped up; in an isometric drawing the two visible edges
are the whole of the illusion, and they cost three paths.

The delivery wires now land somewhere. Each of the four pads sat on a plate's
own edge or inside the footprint of the body standing on it, so the light
arrived at a seam rather than on a surface; two of them were a pixel off a
plinth's rim. Every pad is on bare plate now, clear of the plate's edges and of
the body it serves, and the curves are shaped to approach from a side that
crosses nothing. The product desk was the reason one of them had nowhere to go —
it filled its plate to within ten units — so it is shallower, and the plate has
an apron again.

The lower two planes move now, and neither of them invents a clock. The wires
already ran on one — FAN is 6.4s and every route arrives at a known beat — but
nothing at the far end ever answered, so a packet landed on a pad and the
surface it landed on carried on as though nothing had happened. Each of the
four delivery surfaces is now handed its own route's arrival as a negative
delay: a line types onto the terminal, a message lands on the phone, a row
lands in the product, a tick appears on the schedule, each on the beat its
packet touches down and each clearing again before the next. One run can be
followed from an agent typing on the top plane to the row it becomes at the
bottom.

The control plane in between is deliberately not reacting to anything — it is
simply running, on two slow periods of its own: the model rack answering in a
scan rather than four lamps in lockstep, and the usage bar climbing in steps
before the meter rolls over. The stores stay still — a cabinet blinking its
handles reads as hardware status rather than as work being done. All
of it is CSS, so the world's reduced-motion rule stops it and leaves every
surface showing its finished state.

The leader captions point at things again. Thirteen of them had been left
behind by the rebuild: risers ending in mid-air beside a rack that had since
been mirrored, an anchor a pixel off a plinth's rim, one that ran straight
through an agent's head on its way up, and one whose whole elbow was buried
inside the cube it named. Every anchor now sits a few units inside the
silhouette of the body it names — never on a corner, never in the air — every
riser is routed clear of anything it does not belong to, and the four captions
whose elbow had inverted were moved to the side their leader can actually
reach.

The captions also sat too far out — risers long enough that a label floated in
the dark well clear of the drawing, and on the agent plane one of them reached
so far left it landed in the hero copy. Every riser is shorter now and every
elbow is a short hook rather than a run, so a label hangs off the body it names
instead of orbiting it. The two that still had nowhere to go were re-placed
rather than shortened: one anchors further along its desk so its caption can
lie against the plate, and one drops to where its plate is wide enough to
carry it.
