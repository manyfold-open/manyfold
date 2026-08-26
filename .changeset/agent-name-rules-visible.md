---
'@manyfold/web': minor
---

The agent create form says what a name may contain, and offers to fix one that
does not.

The rules — letters, numbers, emoji, spaces, underscore, dash and dot — were
never written down anywhere on the form. The quick-create row at least turned
red when a name broke them; the advanced form and the external-agent form
render that same field through a different node, and that one carried no hint
and no error. An em dash or an ampersand pasted in from a task title left the
field looking untouched and the Create button grey, with nothing on screen to
say why. That field now states the rules under itself and swaps them for the
error when a name breaks them; the quick row, which stays deliberately terse,
keeps speaking only when something is wrong. Both inputs report `aria-invalid`.

A rejected name usually only misses by a character or two, so `suggestAgentName`
turns it into the nearest legal one — dash lookalikes become a dash, the rest
of the disallowed characters collapse into the spaces around them — and the
form offers that as a one-click repair rather than rewriting what was typed.
