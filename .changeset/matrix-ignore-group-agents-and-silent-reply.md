---
'@manyfold/api': patch
---

Matrix channels now ignore group-room messages from other Narra agent accounts (`@agent-<hex>:`) while keeping direct A2A DMs working, suppress `[NO_REPLY]` / `[silent]` and empty Matrix replies without attachments, keep plain `m.in_reply_to` quotes flat when `autoThread` is disabled instead of anchoring fake threads on quoted messages, use smart quoting in flat group rooms so the latest room message is not unnecessarily quoted, and skip plain display-name substring matching when `m.mentions.user_ids` explicitly targets other users.
