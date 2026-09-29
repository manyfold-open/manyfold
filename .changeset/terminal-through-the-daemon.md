---
'@manyfold/api': minor
---

Every terminal now opens through the machine's daemon, a sandbox's own shell included, and a sleeping sandbox is woken for it. The provider's own exec channel is no longer a fallback. A cloud computer's bare terminal carries the user's API token for its session, like a sandbox's, behind the same terminal switch. Stopping a sandbox detaches the terminals open on it, so it can sleep; an owned terminal keeps its shell for the next attach.
