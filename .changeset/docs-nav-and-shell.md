---
'@manyfold/docs': patch
---

Docs navigation and page shell.

The tree stands open. Sections were collapsed to four labels and a count
until you were inside one, so the dashboard and the changelog showed a rail
holding four words; the count went with the collapse, since an open section
shows what it holds. Groups, the tier below them and the pages under that now
each carry their own mark — a chevron on the left of anything that opens, a
dash on anything that navigates, a hairline down each subtree — and opening a
section animates instead of jumping the rail. Only Channels and the CLI
command list still collapse, and they open when you are inside them. The page
you are on is marked by an arrow where the other rows carry a dash, so the
current row is legible without relying on its colour.

Three columns on a wide screen: the tree, the page, and the page's own section
list pinned beside it. The section list used to sit inline above the first
paragraph, which is where it went when the right-hand rail was removed; it is
back at the right edge, and the inline copy is gone, so the same links no
longer appear twice on one screen. Every surface now uses the same geometry —
a guide, an endpoint, a release note and the docs home all lay their content
out in one column of the same width, where before the index pages ran their
cards to the page edge while their own paragraphs stopped short.

The reading measure is the column's, not the elements'. Prose stopped at 700px
while the tables, the page actions and the rules above and below the article
ran to 824, so the right-hand side of every page showed three different edges
and no reason for any of them. One edge now, at 640px, which is also the width
the widest table in the docs needs — the channel capability matrix fills the
column exactly rather than breaking out of it.

Heading anchors are a link icon revealed on hover, in place of a `##` that was
always on screen and read as markdown that had failed to render. Prev/next
follows the order of the tree instead of a frontmatter field, so Getting
started no longer offers `mf auth` as the page before it. The docs header
carries the marketing site's controls at the marketing site's sizes — the same
wordmark, the same utility row, the same call to action, which was four pixels
shorter here and flat where the other is not. Its page width is the docs
grid's rather than the marketing site's, because three columns do not fit in
the marketing site's.
