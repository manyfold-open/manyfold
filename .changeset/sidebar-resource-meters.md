---
'@manyfold/web': minor
---

Move the resource meters to the foot of the rail.

The concurrency chip hung from the Agents section header, and that header is
not rendered at all when the rail is collapsed — so the one indicator telling
you whether another sandbox can start disappeared exactly when the rail was
narrow enough that you might want to check it without expanding anything.

It now sits in its own strip above the account row, which is where the question
it answers lives: not "what about these agents" but "how much of this account
is left". Collapsed, the chip keeps its tone and drops its numbers — 58px
cannot hold `0/10`, and a glyph that still reads red is worth more than no
glyph at all. The count comes back in the tooltip and in the panel.

Two editions slots ship next to it, both rendering nothing here:
`SidebarCreditMeter` (a balance chip beside the concurrency one) and
`PostSignupOfferModal` (a shell-level mount for a first-visit modal). Open
source has no billing, so the layout is unchanged; a distribution that does
overlays them by path.

`SidebarSectionHeader`'s `meta` slot is removed along with the move: it had
exactly one caller, and an unused extension point on a header that collapses
out of view is an invitation to repeat the bug.
