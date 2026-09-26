## Optional guidance

Load only the references needed for the current task:

- [Authentication](references/auth.md) covers external user login and managed
  runtime grants. The verified identity remains authoritative when an older
  installed CLI's help assumes that every caller is a managed agent.
- [A2A](references/a2a.md) covers delegation and task tracking. Use it when
  talking to a peer or an external A2A server.
- [Workbench](references/workbench.md) covers showing resources and automation
  results. Use [Web routes](references/web-routes.md) to choose the deployment
  origin and resource URL.

Browser capability is optional. When a pane is available, reuse it to show
the live resource; otherwise provide a link when its Web origin is known.
Missing browser controls or an unknown Web URL must not block authorized
CLI work. Never claim visual verification without inspecting the page.

The same `manyfold-cli-usage` skill is distributed independently and inside
the Manyfold plugin. Reuse already-loaded guidance rather than loading a
second copy for the same task. This skill manages platform resources; it
does not define how to develop the Manyfold source repository.
