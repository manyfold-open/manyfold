---
'@manyfold/web': minor
---

Make the model list navigable, and stop tagging every row with its protocol.

A provider can expose 184 models and the list had no search, so finding
`claude-sonnet-4-6` meant reading. It has a search field now, filtering on the
model id, with the header count switching to `8 of 184` while a query is
active and the group counts following the filtered subset.

The deeper change is what a row is. "All" used to de-duplicate by model id, so
a row could stand for the same id served over two protocols with a different
enabled state on each — which is why every row carried a protocol tag, struck
through where that protocol was off, and why one switch had to toggle them all
at once with an indeterminate middle state. A row is now a single
(protocol, model) pair under a protocol group heading. The tag disappears
because the heading says it once, the switch means exactly what it looks like,
and the counts stop contradicting each other: `All` is the sum of its own tabs
(184 = 66 + 45 + 7 + 66), where the de-duplicated count never could be. Group
headings carry that protocol's enabled count and its own enable-all /
disable-all, so the batch controls sit next to what they act on.

`ProtocolModelGrid` derives the grouping itself when a caller passes the whole
protocol map, so existing callers — including the cloud edition's managed
panel — get the grouped view without changing their call. Passing `groups`
explicitly is what a caller with its own search box does.
`SingleProtocolModels` keeps its signature and delegates to the grid, so a
single-protocol tab and the "All" tab render rows the same way.

Two narrow-screen fixes ride along, both of which the search field would
otherwise have made worse. The tab strip scrolls instead of wrapping — a
wrapped row of tabs reads as two rows of buttons rather than one segmented
control — and a row's price drops below the model id instead of squeezing it,
because the tail of `claude-haiku-4-5-20251001` is the part that identifies
it and an ellipsis eats exactly that.
