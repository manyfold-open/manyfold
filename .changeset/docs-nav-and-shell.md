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
command list still collapse, and they open when you are inside them.

The on-this-page rail is gone from the right edge. A page's sections hang off
its own row in the tree, so one column answers both "where am I in the docs"
and "where am I on this page", and the in-content list of sections is the
narrow-screen form of the same thing rather than a second copy of it. The
content column inherits the width, which is what lets a wide table break out
of the reading measure and scroll in place: the channel capability matrix was
laying out at 10 to 15 lines per row.

Heading anchors are a link icon revealed on hover, in place of a `##` that was
always on screen and read as markdown that had failed to render. Prev/next
follows the order of the tree instead of a frontmatter field, so Getting
started no longer offers `mf auth` as the page before it. The docs header now
matches the marketing site's: same page width, same wordmark size, same
utility row. The docs home lists where each section starts instead of
reprinting the whole tree beside the sidebar that already shows it.
