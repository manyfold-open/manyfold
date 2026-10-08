---
'@manyfold/api': minor
---

A framework install on a sandbox or cloud computer no longer ends with a broken CLI when the machine's connection drops while it runs. The platform now follows the running install across every reconnect instead of giving up after the first, and it never retries an install whose machine stopped answering alongside the one still running. On the machine, installs of one framework run one at a time, the cleanup after an install only removes installs it superseded (never one still extracting or the one PATH points into), and an install whose package arrives without its own manifest is rejected before it reaches PATH, for a latest install as well as an exact one.
