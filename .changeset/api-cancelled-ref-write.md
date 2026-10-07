---
'@manyfold/api': patch
---

An external-agent turn (Dify, Langflow, A2A) cancelled while its upstream task reference was being saved no longer ends the API process when that save then finds another instance owns the turn. The late failure is dropped, because nothing is waiting on a cancelled turn's reference write.
