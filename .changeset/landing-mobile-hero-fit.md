---
'@manyfold/web': patch
---

On phones the hero's drawing is centred and the dead air under the copy is
gone.

The world's viewBox had been trimmed to the drawing's ink once, but the ink has
moved since — planes translated, bodies rebuilt — and it had drifted 64 units
right of the frame's centre, which on a phone reads as the whole illustration
sitting off to one side. The viewBox is re-centred on where the ink actually is
now, and the camera's own centre moves with it so the zoomed scenes still frame
the plane they are describing.

The portrait layout gave the art a fixed 46vh band and the copy everything
below it, so the taller the phone the larger the pocket of nothing under the
scroll hint — 146px at 375x812 — while the drawing stayed the same size. The
copy now takes only what it needs and the drawing takes the rest: at 375x812
the art goes from 374px to 464px and the pocket from 146px to 56px. The rail's
scenes are absolutely positioned, so its row cannot size to content; the clamp
is set from the tallest scene there is, which is the Chinese hero at 305px on a
360-wide phone.

The scenes themselves framed badly in portrait. The art band sat inside the
stage's 22px gutter, so a drawing that was already wider than the band showed
two pale bars down the sides and lost its leader captions to the clip; the band
is full bleed now, and the gutter belongs to the copy alone. The narrow zoom was
the other half: `km` was 2.3, which put a plane and its labels half again wider
than the phone. A plane plus its captions is about 240px across at rest, so the
narrow keys are 1.45 and 1.35 — the most zoom the width will take.

The camera also gained a horizontal focus. It only ever had `focusY`, so every
zoom happened about the world's own centre, and the planes do not share it —
they sit at 346, 368 and 359 against the world's 388, a difference that any
zoom above 1 magnifies into a plane pushed off to one side. Each scene now
names the centre of the plane it is describing, which squares up the desktop
framing too.
