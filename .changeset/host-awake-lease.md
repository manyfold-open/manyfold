---
'@manyfold/api': minor
---

A machine that can sleep is now held awake for exactly as long as the
platform works on it, and only then. One lease per machine covers the wake,
the daemon's reconnect, the admission and the turn, so a sandbox that
suspended a moment ago no longer answers a message with "the agent's
computer is unavailable": it is woken, held, and the turn runs. Whether a
machine can take work is read from the socket the API holds to its daemon,
never from the last heartbeat; a self-owned computer the API holds no
socket to is offline and says so. Account operations, the terminal, files,
storage and recovery use the same lease, and a call that lands on a socket
the thaw replaced is retried once on the fresh one.
