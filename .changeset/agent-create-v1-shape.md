---
'@manyfold/web': minor
---

The classic create-agent form takes the newer form's shape.

**Framework** is a dropdown — logo and name per row — instead of a collapsible
tile grid, so picking one costs a row rather than a panel that pushes the rest
of the form off screen. The comparison table is unchanged.

**Runtime** no longer hides behind a disclosure and a Sandbox / Computers tab
pair. Every place an agent can land — a sandbox this form creates, a cloud
computer it creates, a runtime that already exists, a sandbox host it can
install into — is one list, rendered as cards or rows (remembered per device,
the same toggle the runtimes dashboard uses), with a filter by kind once more
than one kind is available. Entry points for provisioning a runtime outside
this flow sit under the list and read from the same table the dashboard's
create buttons do, so a new runtime kind appears in both places at once.

**Model provider** is its own section instead of a dialog behind a "Configure
provider" link inside the runtime card: the provider, its key, the framework
model settings and the primary model are all visible while the runtime is being
chosen.

The workspace path moves with it — out of the per-card property grid and into a
single row under the runtime list, since only the selected target's path was
ever editable.

Nothing about the created agent changes: same request body, same provider
gating, same quota limits. Two pieces of chrome are gone: the Sandbox /
Computers tabs (the kind filter replaces them) and the "select a self-owned
computer" holding state — a registered machine is now picked from the list like
any other runtime, and the link to register one sits with the other entry
points. The 30 catalog keys only that chrome used are deleted from all eleven
locales.
