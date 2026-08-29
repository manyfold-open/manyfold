---
'@manyfold/web': minor
---

Settings -> API tokens gets a rail, a dashboard and a per-token page.

It was a single page: a create form stacked on a flat list of rows, each row
cramming the name, status, scopes, four timestamps and the token id onto two
lines, with nowhere to click through to. It now uses the same two-pane shape as
Runtimes, Channels and Model providers — a rail of tokens on the left, a
dashboard when nothing is selected, and the selected token in the pane.

**Rail.** A flat list by default, with Group by offering Status, Scopes and
Expires — the same control the other three rails have, remembered per device,
with expand/collapse all and the selected token's group revealed on a deep
link. Grouping by Expires answers the question this list exists for: which
tokens never die.

**Dashboard.** Counts by status across the top, then every token as a card or a
table row (grid/list toggle remembered per device): status, how many scopes, when
it was last used, when it expires.

**Token page.** Three things the old list never showed: which agent a token is
bound to and whether that binding is enforced, where it was created from
(`cli-poll`, `user-grant`, `cli-browser`, `api`), and what each scope actually
permits — rendered with its summary and risk level instead of a bare machine
string. The usage section says plainly what is known: only a token's last-used
time is recorded, not individual requests, so there is no per-request log to
show.

**Create.** `/settings/api-tokens/new` moves the form into the pane. The
one-time secret is shown there with its Copy button and stays until you leave
the page — previously it rendered inline underneath the form and was never
cleared, so it sat on screen for the rest of the visit.

Revoking still asks for confirmation; afterwards the token's row and page show
Revoked with the time, instead of a banner that scrolls away.
