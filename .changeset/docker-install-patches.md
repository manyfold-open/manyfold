---
---

The admin and k8s-gateway images copy the root `patches/` directory before installing, because the root manifest now patches postgres.js and pnpm will not install without the patch file. Neither image loads postgres.js, so nothing in them changes.
