---
'@manyfold/api': patch
---

Keep failures from daemon WebSocket frame handling and connection cleanup
inside their connection boundary. A failed presence update or malformed frame
closes the affected connection for retry instead of escaping as an unhandled
rejection. Cleanup failures are recorded without terminating the API process.
