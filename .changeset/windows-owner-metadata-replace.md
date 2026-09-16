---
'@manyfold/cli': patch
---

Retry temporary Windows file-replacement denial when publishing protected state and daemon ownership metadata. Keep the original target intact, retain the kernel lock during publication, and bound retries so persistent permission errors still fail startup cleanly.
