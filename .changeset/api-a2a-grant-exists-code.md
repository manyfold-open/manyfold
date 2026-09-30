---
'@manyfold/api': minor
---

Adding an A2A peer caller that already has an active grant is now a `409` with the code `a2a_grant_exists`, and `details` names both agents, so a client can tell it apart from other conflicts. An outbound A2A request that cannot reach its endpoint (an external A2A provider) now names the endpoint in its error.
