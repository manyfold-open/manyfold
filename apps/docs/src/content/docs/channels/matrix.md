---
title: Matrix
description: Connect a Matrix bot account to a Manyfold agent.
order: 14
---
Connect Matrix when you want an agent in direct messages, rooms, or Matrix threads on a public or self-managed homeserver. Manyfold uses the bot account's Client-Server API access token and a long-running `/sync` connection; no public webhook is required.

## What the channel supports

| Capability | Support |
| ---------- | ------- |
| Direct messages and rooms | Yes; DMs reply freely and rooms require a mention by default. |
| Matrix threads | Yes; existing threads can be isolated and group prompts can start a thread automatically. |
| Live progress | Yes; the bot edits one Matrix message while the agent works. |
| Slash commands | Typed commands are supported; Matrix has no Manyfold-managed native command menu. |
| Files and media | Receive and send images, files, audio, and video in unencrypted rooms. |
| Agent-initiated sends | Yes; send to a room or user, or reply to a provider event recorded by this channel. |
| End-to-end encryption | No; the REST provider records encrypted events as dropped. See [ADR-0012](https://github.com/protagolabs/manyfold/blob/develop/docs/decisions/0012-matrix-e2ee-stays-out-of-scope-for-the-rest-provider.md). |

## Prerequisites

- An existing Manyfold agent.
- A dedicated Matrix bot account.
- The bot account's homeserver URL and access token.
- An unencrypted DM or room.

Create the bot account using your homeserver's normal registration or administrator process. Obtain an access token through a trusted Matrix client login or homeserver administration flow; do not put the bot password or token in a room message.

## Connect it to Manyfold

1. Open **Settings -> Channels**.
2. Create a channel and choose **Matrix**.
3. Select the agent and enter a label.
4. Enter the homeserver base URL, for example `https://matrix.example.org`.
5. Paste the bot account access token.
6. Configure room/user access, operator IDs, mention/session behavior, and optional media/history behavior.
7. Create the channel and run **Register**.
8. Invite the bot account into an unencrypted DM or room.
9. Run **Test**.

Registration calls Matrix `whoami`, stores the bot user ID and display name, and starts the `/sync` loop. The first sync stores a cursor without replaying its timeline as new agent turns; later syncs deliver new messages. You do not need to expose or copy the Manyfold inbound URL.

## Rooms, DMs, and mentions

- Matrix DMs are identified from the bot account's `m.direct` account data. Correctly mark the room as a direct chat in your client if it is being treated as a group. An agent-initiated user send can create a trusted private room and records it in `m.direct` best-effort.
- DMs always count as directed to the bot.
- In group rooms, @mention the bot unless the room is listed under **Free-response room IDs** or **Mention only** is off.
- **Allowed room IDs** and **Allowed user IDs** are independent allowlists. Empty means unrestricted; a message must pass every applicable list. An operator is automatically an allowed sender but cannot bypass the room allowlist.
- With **Auto-join invites** on, the bot accepts invites only when the room passes the allowed-room policy. If Allowed users is non-empty, the inviter must be explicitly listed there; being only an operator does not allow the invite.
- **Operator user IDs** control agent-level commands such as `/model`. An empty operator list denies these commands for everyone.

Matrix IDs must be entered in their full form, such as `!room:example.org` and `@alice:example.org`.

## Threads and sessions

- With **Thread isolation** on, an existing Matrix thread has its own agent session.
- With **Auto-thread group replies** on, an accepted unthreaded room message becomes the root of a Matrix thread and the agent replies in that thread.
- With thread isolation on, a non-threaded Matrix reply is scoped to the event it directly references; outbound replies preserve the native reply relation.
- Without thread isolation, group sessions are per user unless **Share session in channel** is enabled.
- Typed commands such as `/new`, `/list`, `/stop`, and `/history` bypass the mention gate. See [Session switching](/docs/channels/session-switching/).

## Message behavior

- Non-encrypted `m.text` events are processed. `m.notice` is ignored by default to prevent bot loops; set `processNotices: true` through the channel API only when notice events are trusted input.
- Images, files, audio, and video are downloaded through the configured homeserver and passed through the common channel attachment limits. In mention-only rooms, a media caption must mention the bot; captionless media is accepted only in DMs, free-response rooms, or rooms where mention-only is off.
- Reactions, stickers, text edits (`m.replace`), and encrypted events do not start agent turns.
- Replies include a best-effort snippet of the referenced event. Sender display names and recent room or thread history are also resolved best-effort and fall back without blocking the message.
- Long answers are split at 3,900 characters before each chunk is rendered as Matrix HTML. Preview mode edits the initial `thinking...` event and falls back to a fresh message if editing fails. Replies preserve native Matrix reply and thread relations, and the bot refreshes its typing indicator while the turn runs.
- When **Attach files the agent links** is on, files referenced by the final agent answer are uploaded as image, file, audio, or video messages after the text reply. Upload failure leaves the text reply intact.

## Agent-initiated sends

The agent bound to an active Matrix channel can reach out first with `mf channels send`. A human token can use the same command when it owns the channel and has `channels:edit`.

Pass exactly one target:

```sh
mf channels send <channelId> --chat-id '!room:example.org' --text 'Standup starts in 10 minutes.'
mf channels send <channelId> --user-id '@alice:example.org' --text 'What did you ship today?'
mf channels send <channelId> --reply-to '$event:example.org' --text 'Thanks, recorded.'
```

- `--chat-id` sends to the full Matrix room ID.
- `--user-id` reuses an `m.direct` room only if the bot is still joined; otherwise it creates a trusted private room and invites that user.
- `--reply-to` accepts an inbound Matrix event ID recorded by the same channel, or the event ID returned by an earlier `--chat-id` send. If that event belongs to a native thread, the reply stays in the thread; if the event lookup fails, Manyfold falls back to a plain reply in the recorded room.

The API records a durable outbound delivery before sending and returns its delivery ID, status, and Matrix event ID. A failed first attempt can remain queued for retry. Agent-initiated sends are limited to 30 per minute per channel.

## Settings

| Setting | Recommendation |
| ------- | -------------- |
| Allowed rooms | Use a room allowlist when the bot account belongs to unrelated rooms. Empty allows every joined room. |
| Allowed users | Use a user allowlist for a private deployment. Empty allows every sender in an allowed room. |
| Operator users | Add the Matrix user IDs allowed to run agent-level commands. Empty denies those commands for everyone. |
| Free-response rooms | Add only rooms where every accepted text message should drive the agent without an @mention. |
| Auto-join invites | Keep on if the bot should accept allowed room invitations automatically. |
| `processNotices` (API) | Keep the default `false` unless `m.notice` events should intentionally drive the agent. |
| Mention only | Keep on for ordinary group rooms; free-response rooms override it. |
| Shared session | Keep off for per-user room context; enable only when the whole room should share one conversation. |
| Thread isolation | Keep on for separate Matrix thread conversations. |
| Auto-thread group replies | Keep on to answer unthreaded group prompts inside a new thread. |
| Attach files the agent links | Keep on to upload files linked by the final agent answer; turn off for text-only output. |
| Backfill room history on mention | Keep on to add recent room or thread messages as background when responding to a group mention. The limit is clamped to 1–100 events. |
| Progress mode | **Preview** edits one message; **Activity** includes tool/thinking activity; **Final** sends only the answer. |
| Send message context | Keep on so the agent receives sender, room, thread, and event IDs. |
| `resetOnIdleMins` (API) | Set a minute threshold to start a fresh session after inactivity; leave unset or `0` to disable. |

## Verify

Run **Test**. A healthy result confirms `whoami` and that the channel status is active. The result separately reports whether a sync token has been stored; `not stored yet` does not fail the test, but it means you should wait for the first sync before sending the verification message. Initial timeline events are intentionally not replayed as new turns, although later history backfill can include recent room/thread messages as background.

## Troubleshooting

- **`whoami` fails**: check the homeserver base URL, token, and whether the token has been revoked.
- **Channel stays connecting or reports a sync error**: confirm the homeserver is reachable from Manyfold and supports the Client-Server `/sync` API.
- **Bot does not join an invite**: enable auto-join and check Allowed room IDs. When Allowed users is non-empty, the inviter must be in that list; Operator users do not override invite policy.
- **Bot does not respond in a room**: @mention its user ID/display name, add the room to Free-response rooms, or turn off Mention only.
- **Messages are ignored**: verify both room and user allowlists and use full Matrix IDs. Operators bypass the user list only; every message must still pass the room list.
- **A DM behaves like a group**: ensure the client has written the room to the bot account's `m.direct` data.
- **Encrypted messages are ignored**: the REST provider is plaintext-only and records encrypted events as dropped. Use an unencrypted room.
- **An attachment is skipped**: check that it is an `mxc://` image/file/audio/video event, fits the 25 MB per-file and 100 MB per-message limits, and has a bot mention in its caption when the room is mention-only.
- **A notice does not trigger the agent**: `m.notice` is off by default; set `processNotices: true` through the channel API only if this input is intentional.
- **An agent-level command is denied**: add the sender's full Matrix user ID to Operator users.
- **Replies start unexpected threads**: review Auto-thread group replies and Thread isolation.
- **An agent-initiated send fails**: confirm the channel is active, pass exactly one target, use full Matrix IDs, and use a reply event ID previously recorded by this channel.
- **A send is delayed by rate limiting**: the provider honors the homeserver's `retry_after_ms` and retries the same transaction up to three times before failing.

## See also

- [Connect channels](/docs/channels/)
- [Session switching](/docs/channels/session-switching/)
- [Telegram](/docs/channels/telegram/)
- [Slack](/docs/channels/slack/)
- [Lark and Feishu](/docs/channels/lark/)
- [Discord](/docs/channels/discord/)
- [Send from an agent](/docs/channels/agent-send/)
- [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)
