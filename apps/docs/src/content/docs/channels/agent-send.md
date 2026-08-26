---
title: Send from an agent
description: Let an agent proactively message a bound channel, including explicit file attachments.
order: 18
---
An agent can use `mf channels send` to start a DM, post into a chat, or reply to a provider message without waiting for a new inbound turn. Replies to that message come back through the normal channel flow and, when **Send message context** is enabled, include a `[Channel message context]` block so the agent can correlate sender, chat, message, reply, and thread IDs.

## Provider support

| Provider                       | Text                          | Explicit workspace files |
| ------------------------------ | ----------------------------- | ------------------------ |
| Lark / Feishu                  | Yes                           | Yes                      |
| Telegram                       | Yes                           | Yes                      |
| WeChat                         | Yes; DM targets only          | No                       |
| Matrix                         | Yes                           | No                       |
| Slack, Discord, Linear, GitHub | Not through direct agent send | No                       |

This is separate from files linked in a normal Agent reply. Telegram does not pass inbound media to the Agent and does not turn file links in an ordinary reply into uploads, but an explicit `mf channels send --file` does upload a workspace file.

WeChat can only send to a user who has already messaged the bot, because that inbound message establishes the provider reply credential.

## Requirements

- The channel must be `active` and bound to the sending Agent. Check with `mf channels list --json`.
- Agent runtime identity needs no extra scope. A human login token must own the channel and have `channels:edit`.
- Each request must specify exactly one destination: `--chat-id`, `--user-id`, or `--reply-to`.
- Use provider IDs from a prior `[Channel message context]` block: `chat_id`, `sender_id`, or `message_id`. A previous send's `providerMessageId` is also a valid reply target.

## Send text or files

```sh
mf channels send <channelId> --user-id <provider_user_id> --text "What did you ship today?"
mf channels send <channelId> --chat-id <provider_chat_id> --text "Standup starts in 10 minutes."
mf channels send <channelId> --reply-to <provider_message_id> --text "Thanks, logged it."
mf channels send <channelId> --chat-id <provider_chat_id> --text "This week's numbers" --file reports/weekly.pdf --file out/chart.png
```

`--text` and `--file` can be used separately or together. Repeat `--file` for up to four paths. Each path must be inside the sending Agent's workspace; use the same relative path shown in the workspace, with an optional leading `/workspace/`.

The platform reads each file at send time and again on retry. Text and files use separate durable deliveries, so a failed file upload retries independently and never resends text that already succeeded.

## Read the result

A text-only or files-only send returns the delivery at the top level:

```json
{
    "deliveryId": "42",
    "status": "sent",
    "providerMessageId": "om_x"
}
```

When text and files are both present, `files` reports the attachment delivery separately:

```json
{
    "deliveryId": "42",
    "status": "sent",
    "providerMessageId": "om_x",
    "files": {
        "deliveryId": "43",
        "status": "sent",
        "providerMessageId": "om_y"
    }
}
```

`sent` means the provider accepted the delivery. `queued` means the first attempt failed and Manyfold will retry with backoff; do not immediately resend it. Keep `providerMessageId` when you need to correlate a reply or reply natively later.

## Limits and recovery

- Each Agent/channel pair is limited to 30 send requests per minute. On a rate-limit error, wait for `retryAfterSec` and batch the outreach.
- If the command says exactly one target is required, keep only one destination option.
- If the channel is draft or paused, ask its owner to activate it.
- If direct text or file send is unsupported, choose a provider listed above or remove `--file`.
- If the file delivery says `no readable files`, verify the workspace paths and resend only the files; already-sent text does not need to be repeated.

## See also

- [Connect channels](/docs/channels/)
- [Lark and Feishu](/docs/channels/lark/)
- [Telegram](/docs/channels/telegram/)
- [WeChat](/docs/channels/weixin/)
- [Matrix](/docs/channels/matrix/)
- [Session switching](/docs/channels/session-switching/)
