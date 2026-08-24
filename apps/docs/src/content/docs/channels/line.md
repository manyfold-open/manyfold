---
title: LINE
description: Connect a LINE Official Account to a Manyfold agent.
order: 15
---

# LINE

Connect LINE when you want an agent reachable from a LINE Official Account — in one-on-one chats with users, and in group chats or multi-person rooms the account has been invited to. Manyfold sets the webhook URL for you; the rest of the setup happens in the LINE Developers console.

## What the channel supports

| Capability | Support |
| ---------- | ------- |
| One-on-one chats | Yes; every text message reaches the agent. |
| Group chats and multi-person rooms | Yes; messages require an explicit @mention by default. |
| Mention detection | Yes; LINE marks its own mention natively, so no name matching is involved. |
| Slash commands | Yes as typed text; LINE has no command-menu API, so nothing appears in a menu. |
| Live progress | No; LINE has no message-edit API, so the agent posts only the finished reply. |
| Typing indicator | One-on-one chats only; LINE's loading animation cannot be shown in a group. |
| Incoming files and media | Yes; images, video, audio and files are downloaded and attached to the turn. |
| Files in a normal Agent reply | No; LINE requires publicly hosted URLs for outbound media, so file links stay in the text. |
| Explicit Agent file send | No; `mf channels send --file` is not supported on LINE. |
| Quoted replies | Yes in groups; the reply quotes the message that triggered it. |
| Stickers | No; a sticker carries no text and no downloadable content, so it is skipped. |

## Prerequisites

- An existing Manyfold agent.
- A LINE Official Account with a Messaging API channel in the [LINE Developers console](https://developers.line.biz/console/).
- Enough message quota on your LINE plan. Manyfold answers with push messages, and **every reply counts against your monthly quota** — including each part of a long reply that had to be split.

## Create the Messaging API channel

1. Sign in to the LINE Developers console and open (or create) a provider.
2. Create a **Messaging API** channel, or enable the Messaging API on an existing LINE Official Account.
3. On the **Basic settings** tab, copy the **Channel secret**.
4. On the **Messaging API** tab, issue a **Channel access token (long-lived)** and copy it. Treat both values like passwords.
5. Still on the **Messaging API** tab, turn on **Allow bot to join group chats** if the agent should work in groups.

Two console settings decide whether messages actually reach Manyfold, and neither can be changed through the API:

- **Use webhook** must be on. Manyfold sets the webhook URL, but it cannot flip this switch — the channel's **Test** action reports when it is off.
- **Auto-reply messages** and **Greeting messages** should be off. Left on, LINE answers first and the user sees two replies. These live under **Response settings**, which the console links out to the LINE Official Account Manager.

## Connect it to Manyfold

1. Open **Settings -> Channels**.
2. Create a channel and choose **LINE**.
3. Select the agent that should receive messages.
4. Enter a label and paste the channel secret and the channel access token.
5. Create the channel.
6. Open the channel detail page and run **Test**.

On registration Manyfold reads the bot identity (`/v2/bot/info`), sets this channel's inbound URL as the webhook endpoint, and activates the channel. Every inbound request is verified against the channel secret with LINE's `x-line-signature` header. Rotating credentials replaces both values at once, so enter the channel secret and the access token together.

## Conversation behavior

- One-on-one chats get a separate session per LINE user.
- In groups and rooms, sessions are separated per user unless **Share session in channel** is enabled.
- LINE has no threads, so there is no thread-isolation setting.
- With **Mention only** on (the default), a group message must @mention the account. Detection uses LINE's own `isSelf` flag on the mention, so renaming the account does not break it — and an `@all` broadcast does not count as a mention.
- Replies are plain text. Markdown is flattened before sending: code fences and inline backticks are unwrapped, `**bold**`/`*italic*`/`~~strike~~` markers are dropped, `[text](url)` becomes `text (url)`, and headings, horizontal rules and blockquote markers are removed. Underscore forms (`_italic_`, `__bold__`) are left alone so identifiers like `my_func_name` survive intact.
- Replies longer than 5,000 characters are split into several messages, and each push carries at most five of them.
- In a group, the reply quotes the message that triggered it. Direct-message replies are not quoted.
- Incoming images, video, audio and files are downloaded with the channel access token and attached to the turn.
- Typed slash commands work everywhere; the command list is in [Session switching](../session-switching/).
- Sender display names are looked up per user and cached for the life of the process.

## Send proactively from the Agent

An Agent can use `mf channels send` to message a LINE user or a group the account belongs to. File sending is not supported on LINE, and there is no way to reply to a specific past message — a quote needs a token that only exists on a message the bot just received. See [Send from an agent](../agent-send/) for target IDs, delivery results and limits.

## Settings

| Setting | Recommendation |
| ------- | -------------- |
| Allowed user IDs | Leave empty to let anyone who can reach the account use the agent; otherwise list LINE user IDs (`U…`). |
| Operator user IDs | Leave empty to disable agent-wide commands such as `/model` from LINE. Anyone listed here can run them, and is allowed through even if the allow list omits them. |
| Allowed group / room IDs | Leave empty to answer in every group the account was invited to; otherwise list group (`C…`) or room (`R…`) IDs. |
| Mention only | Keep on for groups. One-on-one chats are unaffected. |
| Shared session | Keep off for per-user context; turn on when everyone in a group should share one conversation. |
| Send message context | Keep on so the agent receives sender and message IDs with each turn. |
| Progress mode | Fixed to final replies. LINE cannot edit a sent message, so a live preview is impossible. |
| `resetOnIdleMins` (API) | Set a minute threshold to start a fresh session after inactivity; leave unset or `0` to disable. |

## Verify

Run **Test** on the channel detail page. A healthy result confirms the bot identity, that LINE's webhook endpoint points at this channel, and that **Use webhook** is on.

Then test the paths you intend to use:

1. Add the Official Account as a friend and send it a direct message.
2. Send it an image to confirm attachments reach the workspace.
3. For group use, invite the account to a group and send `@YourBot hello`.
4. Run `/help` to confirm the command handler.

## Troubleshooting

- **Test says "Use webhook" is off**: turn it on in the LINE Developers console under **Messaging API**. Manyfold cannot set it through the API.
- **Every message gets two answers**: turn off **Auto-reply messages** and **Greeting messages** in the LINE Official Account Manager.
- **Nothing arrives at all**: run the channel's registration action again, then confirm the webhook URL in the console matches this channel's inbound URL.
- **Group messages are ignored**: mention the account explicitly, or turn off **Mention only**. Also confirm **Allow bot to join group chats** is enabled, and that the group ID passes the allowed-group list if you set one.
- **Replies stop after a while**: check your LINE plan's monthly message quota. Push messages are metered, and a split reply spends one message per part.
- **A sticker gets no response**: stickers carry no text and no downloadable content, so they are skipped.
- **No typing animation in a group**: LINE's loading animation is a one-on-one feature and cannot be shown in a group or room.
- **A user can run `/model` unexpectedly**: they are on the operator list. Operators are allowed through the sender allow list as well.

## See also

- [Connect channels](../)
- [Session switching](../session-switching/)
- [Telegram](../telegram/)
- [WeChat](../weixin/)
- [Send from an agent](../agent-send/)
- [LINE Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)
- [LINE Developers console](https://developers.line.biz/console/)
