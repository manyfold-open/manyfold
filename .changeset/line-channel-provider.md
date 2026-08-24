---
'@manyfold/api': minor
'@manyfold/web': minor
---

Agents can now be reached from a LINE Official Account. Create a Messaging API
channel in the LINE Developers console, paste the channel secret and a
long-lived channel access token, and Manyfold sets the webhook URL and captures
the bot identity for you.

The channel works in one-on-one chats and in groups and multi-person rooms,
with the usual allowed-user, operator and mention-only gating; group mentions
use LINE's own `isSelf` flag rather than name matching. Inbound images, video,
audio and files reach the turn, replies are chunked to LINE's 5,000-character
limit, and a group reply quotes the message that triggered it.

Two limits come from the platform. LINE has no message-edit API, so replies are
final-only — there is no live preview. Outbound media needs publicly hosted
URLs, so the agent's file links stay in the text. Replies are push messages and
count against the LINE plan's monthly quota.

Two console settings still need a human: turn **Use webhook** on (the channel's
Test action reports when it is off) and turn auto-reply messages off, or LINE
answers alongside the agent.
