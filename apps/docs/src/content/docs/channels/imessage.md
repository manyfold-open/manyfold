---
title: iMessage
description: Connect iMessage to a Manyfold agent through a BlueBubbles server on your own Mac.
order: 19
---

Connect iMessage when you want an agent reachable from the Messages app — in one-on-one conversations and in group chats. Apple publishes no iMessage API, so this channel talks to [BlueBubbles Server](https://bluebubbles.app), which you run on a Mac that is signed in to iMessage. Manyfold registers its inbound webhook on that server and sends replies back through its REST API.

This is the one channel that needs hardware you own. Read [Limits and security](#limits-and-security) before you set it up — the trust model is weaker than every other Manyfold channel, and that is a property of what BlueBubbles can and cannot do, not something configuration fixes.

## What the channel supports

| Capability | Support |
| ---------- | ------- |
| One-on-one conversations | Yes; every message reaches the agent. |
| Group chats | Yes; messages must start with a wake word by default. |
| Mention detection | Wake words only. iMessage has no bot identity to @-mention. |
| Slash commands | Yes as typed text; Messages has no command menu. |
| Live progress | No; iMessage cannot edit a sent message, so the agent posts only the finished reply. |
| Typing indicator | No. |
| Reactions as status | No. |
| Incoming files and media | Yes; attachments are downloaded and attached to the turn. |
| Files in a normal Agent reply | Yes; sent as iMessage attachments. |
| Agent-initiated sends | Yes, to an existing conversation or a handle that already has one. |
| Markdown | No; replies are flattened to plain text, one bubble per paragraph. |

## Before you start

You need:

- **A Mac signed in to iMessage** that stays awake and online. A laptop that sleeps will stop delivering messages — see [Limits and security](#limits-and-security).
- **BlueBubbles Server** installed on it, with a server password set.
- **A public URL for that server.** Manyfold runs in the cloud and has to reach your Mac. A Cloudflare Tunnel, ngrok, or Tailscale Funnel all work. Prefer one that terminates TLS.

## Set it up

1. Install BlueBubbles Server on the Mac and complete its setup, including granting Full Disk Access when prompted.
2. In BlueBubbles Server, set a **server password**. This is what Manyfold authenticates with.
3. Expose the server. With Cloudflare:

   ```sh
   cloudflared tunnel --url http://localhost:1234
   ```

   Copy the `https://…` address it prints.
4. In Manyfold, create a channel with provider **iMessage**. Paste the server URL and password, and set at least one wake word (for example `hey manyfold`).
5. Save. Manyfold pings the server, reads its version, and registers its own webhook — you do not paste a URL into BlueBubbles yourself.
6. Run **Test**. Every line should be a `✓`.

## Wake words

iMessage has no bot account, so there is nothing for a group member to @-mention. Group messages therefore reach the agent only when they begin with one of the channel's wake words, which is then stripped before the agent sees the message:

> **hey manyfold** what did we ship this week?

becomes `what did we ship this week?`.

Wake words are matched case-insensitively at a word boundary, so `manyfold` does not match `manyfoldish`. They are always literal text — regular expressions are not accepted. One-on-one conversations ignore wake words entirely; every message is a turn.

## Who can use it

Leave **allowed handles** empty and anyone who can message that Mac can drive the agent. Fill it in to restrict. Handles are phone numbers or email addresses; formatting is ignored when matching, so `+1 (555) 555-0123` and `+15555550123` are the same person.

**Operators** may run agent-wide commands such as `/model`. With no operators, those commands are disabled from iMessage.

**Allowed chat GUIDs** restrict which group conversations the agent answers in. A chat GUID looks like `iMessage;+;chat123456789`. A blocked chat stays blocked even for an operator.

## The Private API helper

BlueBubbles ships an optional Private API helper that unlocks features Apple does not expose. Manyfold detects whether it is connected and reports it in **Test**.

Everything this channel does — sending, receiving, attachments in both directions — works **without** it. The single thing that needs it is starting a brand-new conversation with a handle that has never messaged this Mac. Without the helper, an agent-initiated send to an unknown number fails with a clear error instead.

Installing the helper requires disabling System Integrity Protection on that Mac. That is a real security decision about your own machine, and it is not required for normal use of this channel.

## Limits and security

**The webhook secret is a bearer capability.** BlueBubbles cannot send custom headers and cannot sign its payloads, so Manyfold authenticates inbound messages with a per-channel secret embedded in the registered webhook URL. That URL is visible in the BlueBubbles webhook list, in your Mac's logs, and in your tunnel provider's request log. Anyone who can read it can send messages to this agent, and because the sender is read from the message body, they can make it look like it came from an allowed handle. The allowed-handles list is not a second factor. Treat the registered URL as a password.

**Rotation means recreating the channel.** Re-registering deliberately reuses the existing secret so it cannot orphan the URL BlueBubbles already holds. To invalidate a leaked URL, change the server password (which re-registers with a fresh secret) or delete and recreate the channel.

**Use HTTPS.** The server password and the webhook secret both travel in query strings, because that is the only authentication BlueBubbles accepts. Over plain `http://` they are readable in transit. Test warns when the server URL is not HTTPS.

**One server, one channel.** BlueBubbles webhooks are per-server, not per-conversation. Two Manyfold channels pointed at the same Mac will both receive every message and both reply. Use allowed chat GUIDs to separate them, or run one channel per Mac.

**The channel can look healthy while the Mac is asleep.** Inbound arrives as an ordinary webhook, so Manyfold has no live connection to monitor. If the Mac sleeps or loses its tunnel, the channel still reads `active` while nothing is delivered. If replies stop, run **Test** — it is the authoritative check. On the Mac, prevent sleep with Energy Saver or `caffeinate -s`.

**Edited messages do not reach the agent.** iMessage delivers an edit as an update to the same message, which Manyfold's duplicate protection discards. Send a new message instead.

**Phone numbers are stored.** Sender handles are written to session names and delivery records, and the raw message payload is retained like every other channel's. If that matters for the people in these conversations, take it into account before connecting.
