---
'@manyfold/cli': minor
---

File operations and terminals on the daemon now accept the folders Manyfold vouches for, the way commands already do, so a hosted machine's files and shells are reachable without registering each folder first. No folder, vouched for or registered, reaches into the daemon's own settings folder, where its tokens and command records live, beyond its workspaces and sign-ins. A terminal whose folder is refused no longer keeps the sign-in it was about to use locked.
