# mf channels send — agent guide

## Purpose

Proactively send a message through one of YOUR bound channels — start a DM,
post into a chat, or reply natively to a specific provider message. Use it to
reach out first (e.g. ask each member for their daily update); their replies
come back to you as normal turns that begin with a `[Channel message context]`
block carrying sender/chat/message ids you can correlate against what you sent.

## Requirements

- The channel must be **bound to this agent** and `active` — check with
  `mf channels list --json`.
- Agent runtime identity needs no extra scope. A human `mf login` token needs
  `channels:edit` and must own the channel.
- Provider support (text): Lark/Feishu, Telegram, WeChat, Matrix; others
  return "does not support agent send yet". File attachments (`--file`):
  Lark/Feishu and Telegram today.

## Usage

Exactly one target per send; `--text`, `--file`, or both:

```sh
mf channels send <channelId> --user-id <open_id> --text "Daily report time — what did you ship today?"
mf channels send <channelId> --chat-id <chat_id> --text "Standup thread opens in 10 minutes."
mf channels send <channelId> --reply-to <provider_message_id> --text "Thanks, logged it."
mf channels send <channelId> --chat-id <chat_id> --text "This week's numbers" --file reports/weekly.pdf --file out/chart.png
```

- `--file` — a path inside YOUR workspace (repeatable, max 4, ≤ the chat
  upload size caps). The platform reads the file server-side at send time;
  pass the same relative path you see in your workspace (a leading
  `/workspace/` prefix is accepted). Files go out as their own message right
  after the text, and retry independently — a flaky upload never re-sends
  your text.

- `--user-id` — DM a provider user id (Lark `open_id`, from the context block's
  `sender_id` of an earlier message or your operator).
- `--chat-id` — post to a group/chat id (context block `chat_id`).
- `--reply-to` — reply natively to a provider message id (context block
  `message_id`, or the `providerMessageId` a previous send returned).

## Output

Prints the JSON result:

```json
{ "deliveryId": "42", "status": "sent", "providerMessageId": "om_x" }
```

With `--file`, a `files` object reports the attachment delivery separately
(files-only sends report through the top-level fields instead):

```json
{
    "deliveryId": "42",
    "status": "sent",
    "providerMessageId": "om_x",
    "files": { "deliveryId": "43", "status": "sent", "providerMessageId": "om_y" }
}
```

- `status: "sent"` — delivered; `providerMessageId` is the message you just
  created. Keep it if you need to correlate replies (`reply_to_message_id` in
  inbound context blocks) or reply to your own message later.
- `status: "queued"` — the first attempt failed; the platform retries with
  backoff for a few attempts. Do not resend immediately.

## Failure recovery

- `401`/`403` → the channel is not bound to this agent, or a human token lacks
  `channels:edit` / doesn't own the channel.
- "exactly one target is required" → pass exactly one of `--chat-id`,
  `--user-id`, `--reply-to`.
- "channel is draft/paused" → only `active` channels can send; ask the owner
  to activate it.
- "does not support agent send yet" → the channel's provider has no direct
  send.
- "does not support agent file send yet" → drop `--file` for this provider
  or use a Lark/Feishu/Telegram channel.
- `files.status: "failed"` with "no readable files" → the workspace paths
  don't exist (check with `mf files list` or your shell) — fix the path and
  resend just the file.
- "rate limit exceeded" → max 30 sends per minute per channel; wait
  `retryAfterSec` and batch your outreach.
