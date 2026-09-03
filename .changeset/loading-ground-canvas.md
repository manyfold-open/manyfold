---
'@manyfold/web': patch
---

Stop the viewport flashing grey before the app paints.

`html` / `body` painted `--color-app-bg`, the chassis colour. Since the
neutral axis inverted, the chassis sits 24 levels below the canvas in light
mode (and 14 above it in dark), so every cold load showed a grey viewport
that then jumped to near-white the moment boot rendered — boot fills with
`bg-main`, and the ground underneath it did not match.

They now paint `--color-main-bg`, the canvas boot actually fills with. The
chassis is unaffected: `AppShell` already paints it on its own root, as do
the other eleven top-level surfaces paint theirs, so this layer was only
ever visible in the gap between stylesheet and first paint.
