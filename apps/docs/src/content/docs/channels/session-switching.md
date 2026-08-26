---
title: Session switching
description: Run multiple parallel conversations in one channel, and switch between them with slash commands.
order: 16
---
A single chat or DM with the agent can host multiple parallel conversations. Each conversation is a **session** — its own history, its own context for the model. Session switching lets you keep one chat as a fresh debugging thread, another as your long-running feature work, and move between them without losing either.

The same set of slash commands works in every channel (Telegram, Slack, Lark, Feishu, Discord, Matrix). The active session is automatically remembered for the next message.

## How sessions and scopes work

A **scope** is the part of a channel where one conversation lives. In a 1-on-1 DM the scope is just you and the bot. In a group, the scope can be the whole channel, a single thread, or one person at a time — that depends on the channel's settings (see [Connect channels](/docs/channels/)).

Within each scope you can have:

- **One active session.** New messages flow into it.
- **Inactive sessions.** Previous sessions you switched away from. They keep their history and you can switch back at any time.
- **Deleted sessions.** Archived sessions that no longer show in `/list`. You cannot switch to a deleted session; create a new one instead.

Switching sessions doesn't touch the underlying chat history; it just moves the "active" marker. The agent sees only the session you've activated.

## Commands

Type these in the channel where the bot is connected. In a group you don't need to mention the bot for a command — a recognized command like `/list` is always treated as directed at the bot. Telegram and Discord register native command menus; Slack can use native slash commands from its app manifest. Telegram's menu inserts the `/list@YourBot` form, which works too.

### `/new [name]`

Start a fresh session and make it active. The previous session is kept in the list. You can give it a name for easier recall later.

```
/new
/new feat-login
/new prod debug
```

### `/list [page]`

Show all sessions in the current scope, with the active one marked. Numbers in the list are stable for the page you're viewing — use them in `/switch` or `/delete`.

```
/list
/list 2
```

A typical output:

```
Sessions in this chat (3 total):
▶ 1. 🏷️ «feat-login» · created 12m ago
◻ 2. 🏷️ «prod debug» · created 1h ago
◻ 3. (untitled) · created 2h ago
Use /switch <number|name>, /current, /new, /help.
```

The `▶` marker is the active session. `🏷️` means the session has a custom name.

### `/switch <number|name>`

Make a session active by index, name, id prefix, or title fragment. The matcher tries in this order:

1. Numeric index from `/list`
2. Exact name (case-insensitive)
3. Channel session id prefix (`chs_…`)
4. Chat session id prefix (`cts_…`)
5. Name prefix (case-insensitive)
6. Chat title substring (case-insensitive)

```
/switch 2
/switch feat-login
/switch prod
```

If the bot can't find a match it tells you. If the target was deleted, it tells you to start a fresh one with `/new`.

### `/current`

Show which session is active and when it was created.

```
/current
```

### `/rename [name]`

Set a friendly name on the active session. The name shows up with the `🏷️` marker in `/list`. It does not change the chat title that the web workspace uses.

Run `/rename` with no argument to clear the name and fall back to the default title.

```
/rename auth refactor
/rename
```

### `/delete <number|name>`

Archive a session. The chat history is preserved (you can still see it in the web workspace), but it no longer shows in `/list` and you can't `/switch` to it.

If you delete the active session and there's still another available, the newest one is activated automatically. If there are no others left, the next message you send starts a fresh session.

```
/delete 3
/delete prod debug
```

### `/stop`

Cancel the response currently running in this scope and discard messages queued behind it. It does not delete the session or its earlier history.

```
/stop
```

If nothing is running, the bot reports that there is no response in progress. The cancellation can take a moment while the underlying runtime stops.

### `/model [name]`

Show the current agent model and available choices, or change the agent-wide default model. A change applies to every session of the agent, not just the current channel session.

```
/model
/model model-name-from-list
```

On Slack, Lark/Feishu, and Matrix, this agent-wide command requires the sender's provider ID in **Operator user IDs**. An empty operator list disables `/model` from those channels. Telegram and Discord allow every accepted channel sender to run it, so use bot/group/server access controls accordingly.

### `/usage`

Show token, cost, and turn totals for the active session plus the agent's aggregate usage over the last 30 days.

```
/usage
```

Providers or models that do not report cost may show a partial or zero cost total.

### `/history`

Show a compact view of the eight most recent messages in the active session. This reads the Manyfold session transcript, not unprocessed history from the external chat platform.

```
/history
```

### `/help`

Print this command reference inside the channel.

## Behavior notes

- **Slash commands never reach the agent.** The bot acknowledges the command and updates its own state. The model does not see your `/list`, `/switch`, etc. Replies stay in the channel for you to read.
- **Commands bypass the group mention gate.** In mention-only groups you still mention the bot to talk to the agent, but recognized commands (`/new`, `/list`, `/switch`, …) run without a mention. Telegram supports `/list@YourBot`; Slack and Discord can send native slash invocations.
- **Native command thread behavior varies.** Slack's native slash payload has no composer-thread context, so it uses the channel-level scope. Discord interactions include their channel/thread. Typed commands follow the normal message scope.
- **Agent-wide commands are privileged.** `/model` changes the default for every session. Slack, Lark/Feishu, and Matrix require an operator; their empty operator list is fail-closed. Telegram has no operator list and treats every accepted sender as an operator, so access to the bot is the security boundary.
- **One conversation at a time.** If the agent is still working on a previous turn in another session, the new turn waits. Switching to a different session lets you message it immediately without interrupting the busy one.

## Idle auto-reset

For long-running chats it's easy to accumulate context that drifts off-topic. A workspace can configure a channel to automatically start a fresh session when a scope has been quiet for a while. Set the channel's `resetOnIdleMins` to a number (minutes). When inactivity exceeds that threshold, the next message starts a new session and the old one is archived in the background. The cap is one week (10080 minutes). Leave it unset or set to 0 to disable.

The reset is silent — no banner message — so people see a clean conversation rather than a "context reset" notification. The old session stays available in `/list`.

## API and CLI access

You can also manage sessions outside of chat:

- **CLI:** `mf channels sessions list|new|switch|rename|delete` — see `mf channels sessions --help`.
- **REST:** `GET /channels/:id/scopes`, `GET /channels/:id/sessions`, `POST /channels/:id/sessions`, `PATCH /channels/:id/sessions/:sessionId`, `DELETE /channels/:id/sessions/:sessionId`.

## See also

- [Connect channels](/docs/channels/)
- [Telegram](/docs/channels/telegram/)
- [Slack](/docs/channels/slack/)
- [Lark and Feishu](/docs/channels/lark/)
- [Discord](/docs/channels/discord/)
- [Matrix](/docs/channels/matrix/)
