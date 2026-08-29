---
'@manyfold/web': patch
---

The model providers rail is a plain list: no search box, no group header.

Settings -> Model providers opened with a search field over a single
collapsible "Your providers" group — a filter and a fold for a list that is
almost always a handful of rows, and whose one group never had a second group
to sit beside. Both are gone. The rail now lists the managed account (cloud)
and every configured provider directly under the title and its count, each row
still showing its protocol and enabled/total model counts, and the rows sit at
the rail's own left edge instead of indented under a header that no longer
exists.

The empty rail keeps its "No providers yet." message; the "No matches."
variant went with the search.
