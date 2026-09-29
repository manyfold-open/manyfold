---
'@manyfold/api': minor
---

A sandbox's daemon now runs under the sandbox's own service supervisor, in a loop that restarts it whenever it exits. Before, the daemon was started from a command and did not survive the sandbox's environment restarting (a cold boot or a checkpoint restore), so the next action on the sandbox had to start it again first. A daemon started the old way is handed over to the loop the next time Manyfold brings it up. Updating a sandbox's Manyfold CLI now applies by the daemon exiting and the loop starting the new version. The daemon's loop and the stub that routes the sandbox's public address are listed as managed on the sandbox's services, and a sandbox stop or a service delete leaves both alone. A sandbox's public address is now the one the sandbox reports: the address derived from its name lacked the organisation's suffix and did not answer.
