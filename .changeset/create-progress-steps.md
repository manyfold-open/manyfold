---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
---

Agent create progress lists only the steps a create actually goes through:

- A new sandbox reports starting its runner as a step of its own, right after the VM is made. That wait, about 20 seconds, used to sit under "creating workspace" with nothing on screen.
- A cloud computer (k8s) create lists the steps it reports, instead of Kubernetes objects no create ever named. An external agent's list is validating and adding the agent.
- No list includes the network policy step: it is part of making the VM.
- The admin console's create page and a pending agent's page use the same lists as the web, so a service framework on a sandbox shows its install and service steps.
