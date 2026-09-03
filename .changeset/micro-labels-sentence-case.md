---
'@manyfold/web': minor
'@manyfold/admin': patch
---

Retire the ALL-CAPS micro-label.

Kickers, stat labels, table heads, landing eyebrows and badges all ran
uppercase at `tracking-[0.18em]`. At workbench density that reads as
shouting, and it made the same label look like a different kind of thing
depending on which surface it landed on. They are now sentence case at
normal tracking — the rule the tag family (DESIGN.md §8.3) has always
followed, now binding on every label in the product and on landing.

Caps and wide tracking come out together: the tracking only ever existed to
give capital letterforms air, so it has nothing to do once the caps are
gone. Source strings were already authored in sentence case (`Cost`, `Input
tokens`, `Manyfold · agent hosting & delivery`), so nothing needed
retranslating and the label now reads the same in the DOM, on screen and to
a screen reader.

DESIGN.md §5 and DESIGN.landing.md §5.3 carry the rule; the two registers
agree on it.
