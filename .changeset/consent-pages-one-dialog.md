---
'@manyfold/web': minor
---

Approval pages now read as one dialog. Approving a CLI sign-in, connecting agents to an application, granting an agent permissions, and confirming or restoring an account deletion all share the product dialog's layout: a title, one line on what approving does, the thing to check, and the actions at the bottom right with the primary one last. Explanations that said the same thing three times are merged, so the code check now carries the safety warning. Boxes nested inside the card become a single list, and the A2A exposure switch only appears once a selected agent needs it. The permission request opened from chat uses the same layout.
