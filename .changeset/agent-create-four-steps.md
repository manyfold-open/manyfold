---
'@manyfold/web': minor
---

Agent creation gets a fourth variant, `v4`: four steps shown one screen at a
time — agent type, where it runs, model cost, name — reachable at
`/agents/new?variant.agent_create_ux=v4`. The existing variants are unchanged
and remain the default.

Step one lists all nine types in two groups, split by whether the thing is
installed on a machine or connected to a service you already run. That is also
where step two forks, so the heading previews the next question. The groups
name where something runs rather than what it is good at: the nine overlap far
too much for "writes code" or "assistant" to be true of any of them
exclusively. A subscription is a row attribute on the three CLIs that carry
their own vendor sign-in, worded "can use" because those CLIs run on managed
billing just as well.

Step two writes the whole cost on every row, including whether a sign-in
follows — reusing a machine that already runs agents costs neither the minutes
nor the sign-in, and only saying the minutes hides half the price. Rows you
cannot pick stay in place with their reason: a cloud computer fixed to another
framework at purchase, a sandbox whose single public port is already serving a
service framework, an exhausted sandbox quota (which points at an empty sandbox
you can delete), and your own computer when it does not have that CLI yet.

Step three groups the ways to pay by scope — accounts signed in on this machine
(valid only there), account-level balance or key (valid everywhere), or one
more sign-in on this machine. A sleeping sandbox reports its last known values
and is never woken just to fill the list. Frameworks that call a model API
instead of carrying a sign-in say so and offer the way back to step one.

A bar across the top carries every step's name with the answer under it, so standing on model cost you can still see which agent type you picked — each step's question only ever restates the step immediately before it. Finished steps in that bar are clickable and take you back. It shows the short form of each answer; the confirmation list on the last step keeps the full one. Below the medium breakpoint the bar falls back to a single line of step names, which stay clickable.

Everything the flow starts, it finishes on the flow's own page. Signing in to your Claude, ChatGPT or Google account opens the CLI's login in the step that asked who pays; connecting your own computer and connecting a Dify, Langflow or A2A service each open where you are. Renting a cloud computer is the one thing that still takes you elsewhere, because it ends in a purchase.

Nothing is preselected and no progress is kept: leave halfway and you start
again from step one, but the machine built, the CLI installed and the account
signed in are all still there, waiting as ordinary rows with no "last time"
marker. An agent is only created in the final step, so an abandoned run never
leaves a half-made one behind.
