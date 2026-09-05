---
'@manyfold/web': patch
---

Scan the editions overlay directory for Tailwind classes.

`tailwind.config.ts` listed `./src` and nothing else, but a distribution that
sets `MF_WEB_OVERLAY_DIR` replaces modules under `./src` by path — so part of
the markup Tailwind is generating rules for lives outside the directory it was
looking at. Any utility used _only_ by an overlay module was therefore purged,
and the failure is silent: the class stays on the element, no rule is emitted,
nothing warns. A `pl-7` reserving room for an input's prefix adornment was
dropped this way, and the adornment landed on top of the value.

The config now appends `$MF_WEB_OVERLAY_DIR/**/*.{ts,tsx}` when that variable
is set — the same signal `vite.config.ts` already keys the overlay resolver
off, so the two agree on what the app is made of. Unset here, where the spread
contributes nothing and the content globs are byte-identical to before.
