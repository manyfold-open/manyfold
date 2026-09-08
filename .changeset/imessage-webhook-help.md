---
'@manyfold/web': patch
---

Show the iMessage webhook help text on the channel settings page. The iMessage provider's `webhookHelp` copy shipped in the catalogs but the settings view never referenced it, so it fell back to the generic help; iMessage now renders its own BlueBubbles-specific guidance.
