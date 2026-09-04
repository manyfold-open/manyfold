---
'@manyfold/web': patch
---

Keep the landing copy on screen when the language changes.

Switching language on the landing page left the whole left-hand column blank —
nav and artwork intact, hero headline, tagline and CTAs gone — until the next
scroll brought them back. The five scrollytelling cards cross-fade, so
`.lp-scene` defaults to `opacity: 0` and the scroll loop writes the live
opacity in; but each card was keyed by its own eyebrow text, so a language
change gave every card a new key, React remounted all five, and the fresh
nodes came up with no inline style and nothing to repaint them. The cards are
now keyed by position: the copy swaps in place, and a switch made part-way
through the story keeps the scene the reader is on.
