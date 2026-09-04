---
'@manyfold/web': patch
---

Scan the editions overlay for Tailwind classes.

`MF_WEB_OVERLAY_DIR` puts a second `src/` in front of this one at module
resolution (vite-overlay.ts), and vite has honoured it since the editions
split. Tailwind never did: its content globs list `./src/**/*.{ts,tsx}` and
nothing else, and Tailwind scans files rather than the module graph. So every
utility referenced only by an overlay module was absent from the built CSS —
the class in the DOM, no rule behind it, and no error anywhere, in dev and in
production alike.

It fails quietly in whatever way the missing property happens to fail. A
`grid-cols-4` that never generated leaves `display: grid` with one column, so
a row of four amount buttons in the cloud build's top-up dialog has been
stacking vertically; `sm:border-r`, `hover:text-link` and a couple of
arbitrary `min-w-[…]` values were missing the same way. Anything the
open-source tree happens to use as well kept working, which is why this reads
as occasional wonky layout rather than as one broken thing.

The overlay dir now joins the content list, resolved against this config the
way `vite.config.ts` resolves the same value. Verified against a cloud
overlay: five classes used only there — including `grid-cols-4` — go from
absent to present in the served stylesheet, and the dialog's buttons sit in
one row again. Nothing changes for a build that does not set the variable.
