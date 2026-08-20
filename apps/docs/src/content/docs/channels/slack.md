---
title: Slack
description: Connect a Slack app to a Manyfold agent.
order: 11
---

# Slack

Connect Slack when you want an agent in direct messages, public or private channels, multiparty DMs, threads, or the Slack Assistant panel. Slack uses a signed webhook for events and native slash commands.

## What the channel supports

| Capability | Support |
| ---------- | ------- |
| DMs, channels, and threads | Yes; channels require an @mention by default. |
| Slack Assistant / DM threads | Yes; each thread can have an isolated session. |
| Native slash commands | Yes; replies to native commands are ephemeral. |
| Incoming files | Yes; file-only messages work too. |
| Agent-produced files | Yes; linked workspace files can be uploaded to the channel or thread. |
| Live progress | Yes; one message is updated while the agent works. |
| User and operator allowlists | Yes; Slack user IDs are checked before dispatch. |

## Prerequisites

- An existing Manyfold agent.
- Permission to create and install a Slack app in the workspace.
- Permission to invite the app to each target channel.

## Set up from Manyfold's manifest

The generated manifest becomes available after a Manyfold channel has its channel-specific inbound URL. It is useful when you are recreating/migrating an app or want Slack to validate the complete configuration in one operation.

For a new setup, use this bootstrap flow:

1. Create and install a minimal bootstrap Slack app so you have an `xoxb-` token and signing secret.
2. Use those credentials to create the Slack channel in Manyfold and obtain its inbound URL.
3. Open the channel detail page and choose **Copy manifest JSON**.
4. In [Slack API Apps](https://api.slack.com/apps), choose **Create New App -> From an app manifest**.
5. Select the workspace, paste the JSON, review it, and create the app.
6. Under **OAuth & Permissions**, install or reinstall the app to the workspace.
7. Replace the bootstrap credentials in the Manyfold channel with the final app's Bot User OAuth Token and signing secret.
8. Remove the bootstrap app if it is no longer used, then run the channel registration and test actions.

The manifest configures the Request URL, all event subscriptions, all 11 slash commands, and the scopes needed for files. Slash command names are workspace-wide; if another app already owns a name such as `/new`, rename that command in the manifest before installing.

## Manual Slack app setup

Create an app from scratch, add a bot user, and add these bot token scopes:

| Scope | Required for |
| ----- | ------------ |
| `app_mentions:read` | Receiving @mentions in channels. |
| `channels:history` | Public channel message events. |
| `groups:history` | Private channel message events. |
| `im:history` | Direct-message events. |
| `mpim:history` | Multiparty direct-message events. |
| `chat:write` | Replies and live progress messages. |
| `commands` | Native slash commands. |
| `files:read` | Downloading files users attach. |
| `files:write` | Uploading workspace files produced by the agent. |

Under **Event Subscriptions**, set the channel's Manyfold inbound URL as the Request URL and subscribe to:

| Bot event | Required for |
| --------- | ------------ |
| `app_mention` | Explicit @mentions in channels. |
| `message.channels` | Public channel messages, including file shares. |
| `message.groups` | Private channel messages. |
| `message.im` | Direct messages and Assistant conversations. |
| `message.mpim` | Multiparty direct messages. |

Create each command listed by `/help` under **Slash Commands** and point every command to the same Manyfold inbound URL. After changing scopes, events, or commands, reinstall the app to the workspace.

## Connect it to Manyfold

1. Open **Settings -> Channels**.
2. Create a channel and choose **Slack**.
3. Select the agent and enter a label.
4. Paste the `xoxb-` Bot User OAuth Token and signing secret.
5. Create the channel.
6. Copy its inbound URL into Slack's Event Subscriptions and slash commands, unless you used the generated manifest.
7. Install/reinstall the Slack app and invite it to each target channel.
8. Run **Register**, then **Test**.

Registration uses `auth.test` to store the bot user and workspace IDs. Messages from a different workspace are rejected, so register again after moving or reinstalling the app in another workspace.

## Messages and files

- Text and Slack file shares can drive the agent; a file-only message is accepted.
- Incoming files use Slack's authenticated download URLs. Manyfold accepts up to 10 files, 25 MB per file, and 100 MB total per message; unsupported or oversized files are skipped while the remaining message continues.
- When **Attach files the agent links** is on, a workspace file linked in the final answer is uploaded to the same channel or thread.
- Long replies are split into chunks. Continuation chunks stay in the active Slack thread.
- Slack markdown links and basic emphasis are rendered in Slack's native format.

File input still depends on the selected agent framework supporting attachments.

## Threads and commands

- With **Thread isolation** on, each channel thread, Assistant conversation, or manual DM thread maps to its own session. Plain DMs keep one flat session per user.
- **Auto-thread** answers a top-level channel mention in a new thread rooted at that message. It requires thread isolation and does not apply to DMs or slash commands.
- Native slash commands use Slack's command payload and return a private ephemeral response. Slack's slash-command composer does not include thread context, so native commands operate on the channel-level scope rather than the open thread.
- Typed commands still use the normal message flow. See [Session switching](../session-switching/) for the full command list.

## Settings

| Setting | Recommendation |
| ------- | -------------- |
| Mention only | Keep on for channels. DMs remain available without mentions. |
| Shared session | Keep off for per-user channel context; enable only for a deliberately shared team conversation. |
| Thread isolation | Keep on so Slack threads remain separate sessions. |
| Auto-thread | Enable when top-level mentions should move into a thread automatically. |
| Progress mode | **Preview** edits one live message; **Activity** includes tool/thinking activity; **Final** sends only the answer. |
| Attach files the agent links | Keep on if users should receive generated workspace files in Slack. |
| Send message context | Keep on so the agent receives sender, workspace/channel, thread, and message IDs. |

## Access control

| Setting | Effect |
| ------- | ------ |
| Allowed user IDs | If non-empty, only these Slack users and configured operators may use the bot. Empty allows anyone the app can reach in its registered workspace. |
| Operator user IDs | Users allowed to run agent-wide commands such as `/model`. Empty disables those commands from Slack. |

Find a Slack user ID from the member profile's three-dot menu with **Copy member ID**. Operators automatically have chat permission. Slack identities are external actors and are not linked to Manyfold accounts.

## Verify

Run **Test** to verify the token with `auth.test` and confirm the channel is active. Then:

1. DM the app.
2. Invite it to a channel and @mention it.
3. Run `/help` from Slack's command menu.
4. Upload a small file if file input is required.

## Troubleshooting

- **Request URL verification fails**: confirm the signing secret and use the current inbound URL from Manyfold.
- **Bot ignores DMs or a channel type**: add the corresponding `message.*` event and history scope, then reinstall the app.
- **Bot receives a channel message but cannot reply**: invite it to the channel and confirm `chat:write`.
- **Slash command is missing or returns to the wrong app**: add `commands`, create the command with this channel's URL, and resolve any workspace-wide name conflict.
- **Scope or event changes do not apply**: reinstall the Slack app.
- **File input fails**: confirm `files:read`; for output confirm `files:write` and **Attach files the agent links**.
- **Users are silently ignored**: check Allowed user IDs and confirm the app is still installed in the workspace recorded by the channel.
- **Replies appear in the wrong scope**: check **Thread isolation**, **Auto-thread**, and **Share session in channel**.

## See also

- [Connect channels](../)
- [Session switching](../session-switching/)
- [Telegram](../telegram/)
- [Lark and Feishu](../lark/)
- [Discord](../discord/)
- [Matrix](../matrix/)
- [Slack app manifests](https://api.slack.com/reference/manifests)
- [Slack Events API](https://api.slack.com/apis/events-api)
