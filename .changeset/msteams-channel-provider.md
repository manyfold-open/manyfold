---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': patch
---

Add a Microsoft Teams channel provider

Bind an agent to a Microsoft Teams bot and reach it from personal chats, group
chats and team channels. Bring your own Azure Bot: paste its app ID, client
secret and tenant ID, run Register to activate the channel, then download a
ready-made Teams app manifest from the channel page and upload it to Teams.

Inbound activities are authenticated by validating the Bot Framework JWT
against Microsoft's key set, checking the audience, the issuer, the signed
service URL and the tenant on the channel. Allowlists are keyed on Entra
(Azure AD) object IDs, never on user names or email addresses, because those
can be reassigned.

Replies stream by editing one message, land in the originating channel thread,
and support typing indicators and agent-initiated sends. Personal-chat
attachments are read; files posted in a channel or group chat are not, because
Teams strips the reference and recovering it needs Microsoft Graph admin
consent.
