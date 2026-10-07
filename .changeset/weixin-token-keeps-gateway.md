---
'@manyfold/api': minor
---

Pasting a new bot token into a WeChat channel keeps the gateway the bot was registered on. Before, an international channel updated from its settings, or with only a `botToken` from the CLI, moved to the default domestic gateway. A gateway named explicitly in the update still replaces the stored one.
