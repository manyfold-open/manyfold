---
'@manyfold/api': minor
'@manyfold/web': minor
---

Added a WhatsApp channel. Create one under Settings -> Channels, scan the QR
code from your phone's **Linked devices** screen, and the agent starts
answering on that number — no token to paste, no webhook to expose, no Meta
Business account.

Direct messages and group chats are both supported. Groups are mention-gated by
default (a reply to the agent counts as addressing it) and can be restricted to
specific group jids. Allowed and operator senders accept either a phone number
or a raw jid. Inbound images and documents reach the agent as attachments, and
files the agent links come back as images or documents. The triggering message
is marked 👀 while the agent works, then ✅ or ❌.

Two things worth knowing before you link a number. Linking runs through
WhatsApp Web, which Meta does not officially support for automated use, so use
a number you can dedicate to the agent rather than your personal one. And if
the linked device is later removed from the phone, the stored session cannot be
revived — delete the channel and scan again.
