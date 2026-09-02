---
'@manyfold/web': patch
---

The landing world's top plane now puts each framework on the runtime it
actually runs on.

The four agent plates are labelled by runtime — stateful sandboxes, cloud
computer, your own machine, external services — but three of the marks standing
on them were placed before the runtimes were, and had drifted into claims that
aren't true: OpenClaw sat in a sandbox, Dify on the cloud computer, and a second
Claude Code stood in for the external services the platform doesn't host. A
reader who knows the frameworks reads the plane as a map, so a mark on the wrong
plate is a wrong statement, not a decoration.

The sandbox plate now carries NarraNexus, the cloud computer carries OpenClaw,
and external services carries Dify — which also stops Claude Code from appearing
twice in a scene whose whole point is that the marks are the variable.

`@lobehub/icons` has no NarraNexus mark, so the world borrows the product's own
asset, the pair `frameworkMeta` already renders everywhere else. It goes in as
two `<image>` elements swapped by theme rather than one tinted mark, because the
stroke is a black-to-grey gradient in light and white-to-grey in dark, which
`currentColor` cannot express; a nested `viewBox` crops the file's square canvas
to the artwork's own band so the mark fills its slot on the head instead of
sitting at 60% with air above and below it.
