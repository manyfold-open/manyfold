---
'@manyfold/web': minor
---

The Update Center now lets you choose which version to install, and it fits more on screen.

The single Version column is split into From and To, and where more than one release is a valid upgrade, To is a picker instead of a fixed value. A machine's mf CLI is offered the versions on the channel it was installed from — plus the other channel only when the machine reports it can cross over — a sandbox is offered both, and an agent framework is offered every catalog release newer than what it has. Skills stay read-only, because both sides of a skill update are git revisions with no catalog between them.

The Status column is one short tag per row again. Long explanations — why a release is withheld, which phase an upgrade is in, what an API refused — moved to a full-width line under the row, so a sentence can no longer stretch the row or squeeze the other columns. Rows are shorter, and the table has the wider page to spread across.

Everywhere else, "a newer version exists" now looks the same: the installed version, and next to it a badge carrying the release you would move to, which takes you to the Update Center. That replaces the sidebar banner, four notice strips, several inline captions and a red card. The sidebar's update count only turns red when something in the list is overdue rather than merely available. Machines the platform cannot upgrade remotely keep their recovery instructions, since for those the commands are the upgrade path.
