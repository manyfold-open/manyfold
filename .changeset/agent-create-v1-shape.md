---
'@manyfold/web': minor
---

The classic create-agent form takes the newer form's shape.

**Framework** is a dropdown — logo and name per row — instead of a collapsible
tile grid, so picking one costs a row rather than a panel that pushes the rest
of the form off screen. The comparison table is unchanged.

**Runtime** no longer hides behind a disclosure and a Sandbox / Computers tab
pair. Every place an agent can land is one list — cards or a table, remembered
per device the way the runtimes dashboard remembers it — with an always-on
filter by kind, and pagination once there are more than eight targets. A row
carries what picking it turns on: its kind, its status, and who already lives
on that machine, one entry per framework with that framework's agent count.
The picker opens with a target already selected when it has one to offer, so
the form is submittable rather than silently blocked on a choice it never
named.

Provisioning a runtime happens where the list ends, not as a row inside it.
A sandbox is created from a dialog that prefills the name the server would
have generated and leaves it editable; a machine is connected through the same
dialog the newer form uses. Both then reload the list, select what they made,
and page to it. Renting a cloud computer still leads to its own page.

**Model provider** is its own section instead of a dialog behind a "Configure
provider" link inside a runtime card, and it no longer disappears when an
existing runtime is picked. Adding an agent to a runtime inherits that
runtime's provider, so that is what the section says — with the agent's own
model editable beside it, and a Change control that sets a different provider
for real. Changing it issues the same request the agent's credentials dialog
does, which replaces the credentials stored for that runtime, so the section
says that too. Narranexus and the external frameworks do not get the control,
because the API refuses it for them.

The workspace path moves out of the per-card property grid into a single row
under the runtime list, since only the selected target's path was ever
editable.

Nothing about the created agent changes: same request body, same provider
gating, same quota limits. Two pieces of chrome are gone — the Sandbox /
Computers tabs, and the "select a self-owned computer" holding state — and an
unattached sandbox mode no longer means "provision one on submit", so the form
waits for a target instead of quietly creating a runtime nobody asked for. The
36 catalog keys only the removed chrome used are deleted from all eleven
locales.
