---
'@manyfold/api': minor
---

A Hermes turn handed to another API instance mid-run (a deploy or restart) now resumes to its real answer. The resume replays the daemon's output from the start, and its first already-stored row used to stop the relay and mark the turn finished with empty content while it was still running; the real answer, with its usage, was then dropped. Hermes now declares that replay, so stored rows are matched rather than written again, and a replayed permission ask is matched the same way. Any resume that stops on a write it cannot land now leaves the turn open for its real final instead of declaring it done.
