---
'@manyfold/web': minor
'@manyfold/api': minor
---

The workspace rail shows whether your own coding agent is connected to Manyfold. A chip beside the concurrency meter reads Connect agent, Connected, or In use (a request in the last 90 seconds); clicking it opens the setup prompt, or a panel with the last request, Connect another agent, Manage sign-ins and Disconnect. The setup dialog now walks through copying the prompt, approving the sign-in and connecting, and confirms on its own once the agent has signed in. Tokens minted by `mf login` are now recorded with `createdVia: 'cli-browser'`, so they can be told apart from tokens made by hand.
