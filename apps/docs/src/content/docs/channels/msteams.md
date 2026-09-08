---
title: Microsoft Teams
description: Connect a Microsoft Teams bot to a Manyfold agent.
order: 18
---

Connect Microsoft Teams when you want an agent reachable from Microsoft 365 — in personal chats with the bot, in group chats, and in the channels of teams it has been installed into. Setup runs in three places: you register an Azure Bot, you paste its credentials into Manyfold, and you upload a Teams app package that points at that bot.

## What the channel supports

| Capability | Support |
| ---------- | ------- |
| Personal chats (DMs) | Yes; every message reaches the agent. |
| Group chats and channels | Yes; messages require an explicit @mention by default. |
| Mention detection | Yes, by the identity Teams resolves, not by the displayed name. |
| Threads | Yes; each Teams channel thread gets its own session, and replies stay in it. |
| Slash commands | Yes as typed text. |
| Live progress | Yes; the agent edits one message while it works. This is the default. |
| Typing indicator | Yes. |
| Reaction acknowledgement | No. |
| Incoming files | In personal chats only. In a channel or group chat, Teams strips the file from what the bot receives — see [Files](#files). |
| Files in a normal Agent reply | No; file links stay in the text. |
| Explicit Agent file send | No; `mf channels send --file` is not supported on Microsoft Teams. |
| Agent-initiated messages | Yes, to a conversation the bot is already part of. |
| History backfill | No; reading past messages needs a Microsoft Graph permission that requires tenant administrator consent. |

## Prerequisites

- An existing Manyfold agent.
- An Azure subscription you can create a bot resource in.
- Permission to upload a custom app to your Microsoft 365 tenant. Many tenants disable this by default; a Teams administrator can enable it under **Teams apps → Manage apps → Org-wide app settings**.

## Register the Azure Bot

1. In the [Azure portal](https://portal.azure.com/), create an **Azure Bot** resource.
2. For **Type of App**, choose **Single Tenant**. Let Azure create a new Microsoft App ID, or point it at an existing app registration.
3. Once the resource exists, note three values — you need all three in Manyfold:
   - the **Microsoft App ID** (the app registration's client ID),
   - the **tenant ID**,
   - a **client secret**, created under the app registration's **Certificates & secrets**. The value is shown once; treat it as a secret.
4. Open the bot resource's **Channels** page and add the **Microsoft Teams** channel.

Leave the messaging endpoint blank for now — Manyfold gives you the URL in the next section.

If you would rather not click through the portal, [`@microsoft/teams.cli`](https://www.npmjs.com/package/@microsoft/teams.cli) does the registration, the secret and a starter manifest in one command. It is in preview, so its flags move between releases.

## Create the channel in Manyfold

1. Go to **Settings → Channels** and create a **Microsoft Teams** channel.
2. Enter the bot app ID, client secret and tenant ID.
3. Save, then open the channel and run **Register**. This proves the credentials against Microsoft, captures the bot identity, and activates the channel.
4. Copy the channel's inbound URL and paste it into the Azure Bot resource under **Settings → Configuration → Messaging endpoint**.

## Upload the Teams app

An Azure Bot is not yet visible in Teams. Teams needs an app package — a zip holding a manifest and two icons — that points at the bot.

1. On the channel page, choose **Download manifest.json**. It is filled in for your bot and this channel.
2. Put it in a zip alongside two PNG icons: `color.png` at 192×192 and `outline.png` at 32×32, transparent and single-colour. All three files must sit at the root of the zip, not inside a folder.
3. In Teams, go to **Apps → Manage your apps → Upload an app → Upload a custom app** and pick the zip.
4. Install it where you want the agent: to yourself for personal chats, or to a team for its channels.

Send the bot a direct message to confirm the round trip.

## Conversation behavior

- Personal chats get a separate session per user. Every message reaches the agent; no mention is needed.
- In group chats and Teams channels, sessions are separated per user unless **Share session in channel** is on.
- Each Teams **channel thread** gets its own session, and the reply lands back in that thread. Turn off **Thread isolation** to share one session across the whole channel. Personal chats and group chats have no threads, so the setting does not apply there.
- With **Mention only** on (the default), a group or channel message must @mention the bot. Detection uses the identity Teams itself resolves on the mention, not the displayed name — so a member who renames themselves to the bot's name cannot fake one, and renaming the bot does not break detection.
- A mention of the bot is stripped from the text the agent sees. A mention of *someone else* is kept, flattened to that person's name, because it is usually part of the instruction.
- The agent posts a placeholder and edits it as it works, then leaves the finished answer in place. Set the reply mode to **Final** to post only the completed answer.
- A typing indicator shows while the agent works. It is refreshed automatically and stops when the turn ends.
- Replies are Markdown. Bold, italic, strikethrough, links, bullet and numbered lists, inline code, fenced blocks and blockquotes all render as written. Headings are converted to bold, because Teams drops the `#` and would otherwise render a heading as ordinary text. Tables are wrapped in a code fence so they arrive aligned rather than as raw pipes.
- Replies longer than 28,000 characters are split across several messages.
- Incoming files work in personal chats only — see [Files](#files).
- Typed slash commands work everywhere; the command list is in [Session switching](../session-switching/).

## Send proactively from the Agent

An Agent can use `mf channels send` to post into a Teams conversation the bot is already part of. Give it a **conversation ID**, not a user ID: reaching a person who has never messaged the bot means creating a conversation, which only works once the app is installed for that user — a precondition Manyfold cannot see or report on. Replying to one specific past message is not supported either, because Teams threads by conversation rather than by referencing a message. File sending is not supported on any Teams surface. See [Send from an agent](../agent-send/) for delivery results and limits.

## Access control

Allowed and operator users are listed by **Entra (Azure AD) object ID** — the GUID on a user's Entra profile. User principal names, email addresses and display names are never matched, because all three can be reassigned to a different person while the object ID cannot. You can read a user's object ID from the Azure portal under **Microsoft Entra ID → Users**.

Leave **Allowed user IDs** empty to let anyone in the tenant use the bot. **Operator user IDs** control who may run agent-wide commands such as `/model`; with no operators listed, those commands are disabled from Teams.

**Allowed conversation IDs** restricts the channel to specific chats or Teams channels. Leave it empty to answer wherever the app is installed.

Activities from a tenant other than the one on the channel are rejected outright, before anything reaches the agent.

## Settings

| Setting | Recommendation |
| ------- | -------------- |
| Allowed user IDs | Leave empty to let anyone in the tenant use the agent; otherwise list Entra object IDs. |
| Operator user IDs | Leave empty to disable agent-wide commands such as `/model` from Teams. Anyone listed can run them, and is allowed through even if the allow list omits them. |
| Allowed conversation IDs | Leave empty to answer wherever the app is installed; otherwise list conversation IDs. A value copied from a Teams deep link keeps working — the `;messageid=` suffix is ignored when matching. |
| Mention only | Keep on for group chats and channels. Personal chats are unaffected. |
| Share session in channel | Keep off for per-user context; turn on when everyone in a channel should share one conversation. |
| Thread isolation | Keep on so each Teams channel thread is its own session. |
| Progress mode | Preview by default: the agent edits one message as it works. Final posts only the completed answer. |
| Send message context | Keep on so the agent receives sender, conversation and message IDs with each turn. |
| Bot Connector endpoint | Leave empty for the public cloud. Set it only for a government or sovereign cloud. |
| `resetOnIdleMins` (API) | Set a minute threshold to start a fresh session after inactivity; leave unset or `0` to disable. |

## Files

Personal-chat attachments work: send the bot a file in a direct message and the agent receives it.

Files in a **channel or group chat** do not. Teams removes the file reference from what it delivers to a bot and sends an HTML placeholder instead. Recovering the file needs Microsoft Graph application permissions plus tenant administrator consent, which this channel deliberately does not ask for. The agent sees the message text without the attachment.

The agent cannot send files back on any Teams surface; file paths appear in the reply text instead.

## Non-public clouds

The channel talks to the public Bot Connector by default. For a government or sovereign cloud, set **Bot Connector endpoint** on the channel to the endpoint Microsoft documents for it — for example `https://smba.infra.gov.teams.microsoft.us/teams` for GCC High. Only Microsoft's own Bot Connector hosts are accepted.

## Verify

Run **Test** on the channel detail page. It confirms the credentials still mint a Bot Connector token and that the configured endpoint is recognised. It deliberately does **not** claim Teams can reach you: the Bot Connector never calls back on demand, so only a real message proves the inbound path.

Then test the paths you intend to use:

1. Send the bot a direct message.
2. Send it a file in that direct message to confirm attachments reach the workspace.
3. For team use, @mention it in a channel, then reply inside the thread it answered in.
4. Run `/help` to confirm the command handler.

If a message produces nothing, open the channel's **Deliveries** list — a rejected inbound is recorded there with a machine-readable reason.

## Troubleshooting

**Nothing arrives at all.** Check that the messaging endpoint in the Azure portal is exactly the channel's inbound URL, that the Microsoft Teams channel is enabled on the bot resource, and that the app is installed where you are messaging from.

**Every message is ignored, and the channel shows rejected deliveries.** Open the channel's delivery list and read the rejection reason. `tenant_mismatch` means the tenant ID on the channel is not the tenant the message came from. A token verification failure usually means the app ID on the channel is not the one the messaging endpoint belongs to.

**The bot answers in a personal chat but not in a channel.** Channel messages need an @mention by default. If mentioning it does nothing, the app was installed to you personally rather than to the team — reinstall it to the team.

**Replies fail after a credential change.** Rotating credentials replaces the app ID, secret and tenant ID together. Re-enter all three, then run **Test**.

**The manifest will not upload.** Custom app upload is disabled in many tenants; a Teams administrator enables it under **Teams apps → Manage apps → Org-wide app settings**. Also confirm the zip has the manifest and both icons at its root, with the icons at exactly 192×192 and 32×32.

## See also

- [Channels overview](../../channels/) — what every channel shares.
- [Session switching](../session-switching/) — the slash commands available in a conversation.
- [Send from an agent](../agent-send/) — agent-initiated messages and their limits.
