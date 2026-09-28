---
version: '5.4.0'
date: '2026-09-28'
---

The daemon no longer keeps a command's input on disk. File operations and
terminals on a hosted machine accept the folders Manyfold vouches for. No
folder, whether vouched for or registered, reaches the daemon's own
settings, where its tokens live, beyond its workspaces and sign-ins. A file
too large for a single message is written in parts, and it replaces the
destination only once it is complete and its checksum matches.
