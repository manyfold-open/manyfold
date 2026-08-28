---
---

Internal cleanup with no observable behavior: 355 translation keys no source in either edition references (statically or through a dynamic template family) leave all 11 locale catalogs. Every key was verified unused by an AST scan over the OSS apps and the cloud overlays plus a hand-checked sample; the cross-locale key-set assertions stayed green throughout.
