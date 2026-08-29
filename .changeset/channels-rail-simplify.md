---
'@manyfold/web': minor
---

Channels and model providers each get a dashboard, and their rails become
plain lists.

**The rails.** Settings -> Channels opened grouped by platform under a search
field and All / Active / Issues chips; Settings -> Model providers opened
under a search field and a single collapsible "Your providers" group that
never had a second group to sit beside. Channels' Group by now offers None
and defaults to it — one flat list, most recently updated first, each row
carrying its platform and its agent — and both search boxes, the status chips
and the providers group header are gone. Platform / Agent / Status grouping on
channels are unchanged, and grouping by status still gathers the paused and
errored channels together. Because the grouping is remembered per device, the
channels store key moved to v2: browsers that had already chosen a grouping
start again on None.

**The dashboards.** Both areas now open on an overview instead of a
"nothing selected" panel, the way Settings -> Runtimes already did, with a
grid/list toggle remembered per device and a create button in the header.

Model providers shows spend, tokens, requests and last use per configured
provider over a 7-day, 30-day or all-time window. Spend that could not be
attributed to a provider — turns whose agent had no provider bound, or whose
provider was deleted — gets its own row rather than quietly vanishing from the
total. Turns with no recorded cost are never counted as free: a provider whose
cost is entirely unknown reads as a dash, and a partially-priced one carries an
"N unpriced" tag saying the amount is a lower bound.

Channels shows each channel's status, its message count, when it last carried
a message, and its agent. The count covers a window because delivery history
is pruned, and the label states the window the deployment actually keeps
rather than assuming 30 days. The last-message time is not windowed, so a
channel can honestly show no messages this month and still say when it last
spoke.
