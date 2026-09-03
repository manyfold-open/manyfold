---
'@manyfold/web': minor
---

Land Fraunces as the landing's display face.

The spec has said Fraunces since it was written — SOFT 50, WONK 0, weight 300
— but `styles.css` imported Source Serif 4, and had since the register was
built. A plan was written down and never executed, and the two are not the
same kind of serif: Fraunces is a high-contrast display face drawn for large
sizes, Source Serif 4 is a low-contrast text face Adobe drew for screen body
copy. Every rule downstream of that choice — weight, tracking, the optical
size cut a heading lands on — was tuned for a face the page was not using.

The page now loads `@fontsource-variable/fraunces/full.css`, not `opsz.css`:
Fraunces carries four axes and this register uses SOFT, which the narrower
file would leave inert with no error. Weight drops to 300, which is where a
display serif sits at the same visual mass a text serif needs 400 for, with
`.lp-h3` overridden back to 400 — at 24-29px the thin strokes stop carrying.

The social cards follow, since they reproduce the hero: someone who clicks a
shared link must not meet a different face on arrival. The zh card gains a
pinned Noto Serif SC so its headline is a serif too, matching the landing's
CJK fallback rather than staying on the sans it had. Cards ship as v5.

Source Serif 4 is removed; nothing else used it.
