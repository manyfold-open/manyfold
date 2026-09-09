---
'@manyfold/web': minor
---

Runtimes can now hold more than one signed-in account, and each agent picks which one it runs under. The runtime page's Account section lists the host sign-in beside the accounts added on that runtime, with Add account, Sign in, Sign out, Remove and a default for new agents; sign-in for an added account opens a terminal already inside the CLI's login, scoped to that account. The create wizard offers the account chooser when an agent joins an existing runtime on its own subscription, and the agent's Model provider tab lets you move an existing agent between accounts (applies from its next run). The chat sign-in card names the account the agent is bound to.
