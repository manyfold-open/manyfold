---
'@manyfold/web': minor
---

The chat page follows model settings changed elsewhere. It loaded them once, then sent that model, saved as the agent's default, with every message, so a chat left open while the model was changed from the CLI (`mf agent update --model`) or another client ran the old model on its next message and saved it back. It now reads them again when they change (and on focus, and every minute while visible). A model picked in the composer and not sent yet is kept.
