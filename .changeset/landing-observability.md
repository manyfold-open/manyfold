---
'@manyfold/web': minor
---

The landing page's metering section is now an observability section.

It used to argue one thing — that a run's price is visible — with a
month-to-date figure heading the section and three claims underneath that were
all restatements of it. What a reader needs in order to trust an agent they
cannot watch is broader than the bill: what it did, what that cost, and what it
was allowed to touch. Those are three peers, so the section is now three
columns instead of three stacked pairs, and the month-to-date figure sits in
the cost column where it belongs.

The paired rows are gone with it. Each row put a wide artefact beside the
sentence it proved, which left the three artefacts at three different heights
with no shared baseline between the halves. The columns are a CSS subgrid, so
every panel sits in the same row and the three share a height without anyone
picking a min-height; stacked under 900px they go back to sizing themselves.
The closing line about failed runs is dropped — the claims carry the section
without it.

The no-JS snapshot follows the same copy, so a crawler reads the section the
page actually shows.
