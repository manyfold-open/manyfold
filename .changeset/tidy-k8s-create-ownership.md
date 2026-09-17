---
'@manyfold/api': patch
---

Keep newly provisioned Kubernetes containers pending until their first agent and configuration are complete. Failed creates now remove only their owned resources, or retain a visible failed container for a safe Delete retry when cleanup cannot finish. Fence concurrent attachment, chat, runner registration, and deletion during this operation.
