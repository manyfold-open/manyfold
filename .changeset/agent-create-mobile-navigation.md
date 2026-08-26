---
'@manyfold/web': patch
---

The create-agent page keeps its mobile header, so a phone cannot strand a new
account on it.

Below `md` the workspace collapses to a drawer and the shell's header holds the
only button that opens it. `/agents/new` sat on the shell's list of routes whose
page draws a header of its own — true while the v1 form did, and not true after
the v3 rewrite, which replaced that header with none. On a narrow screen the
page therefore rendered with no chrome at all, and an account with no agents yet
converges on exactly that page from every direction: signed in, `/` sends you to
the workspace, and a workspace with nothing to open sends you here. An account
that already has an agent could still leave through the form's own close button;
a first-time one has no such button, because there is no workspace for it to
close back to.

The shell draws the header for this route again, and the v1 form drops the
duplicate it was carrying. Chat is the only route left on the list — its toolbar
carries the menu button at every width — and a test now pins both halves of that
deal, so the next rewrite of a page cannot quietly take the navigation with it.
The header's title comes off the same table as the browser tab, so it reads
"New agent" instead of repeating the brand back at itself.
