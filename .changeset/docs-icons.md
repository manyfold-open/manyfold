---
'@manyfold/docs': patch
---

The docs draw their icons from the same library as the app.

Every icon here was a hand-copied path, and they had drifted from the set the
app draws: the menu glyph was a Lucide shape from an earlier release, the
magnifier's circle was a radius short, the book was a form Lucide has since
replaced, and the laptop was a rounded rectangle with a line under it. The
help button was worst — a bubble and a question mark assembled by hand, which
is what made it look wrong rather than merely different.

They come from `@lucide/astro` now, on the same major as the app's
`lucide-react`. Three stay drawn by hand and say why in place: the brand marks,
because Lucide carries none; the current-page arrow in the tree, because
Lucide's has a head twice the weight of the dash beside it; and the code
block's copy button, which is built at runtime by a script and cannot import a
component.
