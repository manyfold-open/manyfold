---
'@manyfold/web': patch
---

The chat's right-hand panels — background tasks, the workspace files (tree +
preview), and the runtime session viewer — now share one side pane whose title
is a dropdown that switches between them, instead of three separate overlapping
panels living at two different layers. Only one is open at a time; the header
buttons and the Shift+Cmd+E / Option+Cmd+B shortcuts open the pane to their
panel, and each single-column panel remembers its own width.
