---
'@manyfold/web': patch
---

The landing world's leader captions now read as blocks instead of nine
different indents.

Every caption is a title with a mono line under it, and the pair is supposed to
hang off one leader. But the second line's `x` had been set by eye for each
one: measured against its own title it sat at -48, -26, -13, -6, +8, +13, +18,
+21 and +48. No two agreed, and on the cloud-computer plate the offset was
large enough that `ALWAYS ON` started where `Cloud computer` ended and ran back
under its own leader. Each mono line now takes its title's `x` and anchor, so
both lines are flush on the side the leader comes from — which is the edge the
elbow points at.

Flush lines are wider than staggered ones, and two captions then reached
artwork their title had cleared on its own, so their leaders drop or rise
further before turning out: `Your own machine` now sits above the screen it was
printing over, and `Stateful sandboxes` has more than the 0.4 units it had
between its mono line and the plate below.

Three placements are fixed alongside them. `Skills & MCP` and the control
plane's own layer title were drawn through each other — the note hangs into the
margin below the plate's near edge, which is where the title lives; the title
now sits further along that edge, since the note cannot move up without landing
on the plate or down without a leader twice the length of any other.
`External services` and `Your schedule` were both printed on their own plate,
crossing its front edge, and now drop clear of it first. The delivery plane's
layer title moves along its edge too: at 1024 it was overlapping the copy
column's third bullet.

Checked at 390, 430, 768, 820, 1024, 1280, 1440 and 1920 across all three
scenes: no caption overlaps another caption, the copy column, or runs off the
stage.
