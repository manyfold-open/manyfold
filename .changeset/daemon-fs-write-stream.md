---
'@manyfold/cli': minor
---

The daemon takes a file larger than one message in parts: each part is appended in order to a private file next to the destination, and the file replaces the destination only once it is complete and its size and checksum match. An interrupted upload never leaves a half-written file behind, and the parts of an upload nobody finishes are cleaned up within two hours or when the daemon restarts.
