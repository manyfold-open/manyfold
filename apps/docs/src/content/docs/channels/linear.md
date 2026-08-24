---
title: Linear
description: Install a Manyfold agent as a Linear workspace member.
order: 16
---
Connect Linear when you want an agent to pick up work where it is already tracked. The agent becomes a workspace member you can @mention or delegate an issue to, and it reports progress on the Linear agent session itself rather than in a comment thread.

Linear's agent APIs are a developer preview, so details on Linear's side may still change.

## What the channel supports

| Capability                        | Support                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Mentions and issue delegation     | Yes; both start an agent session. Delegating sets the agent as issue delegate, so a person stays the assignee. |
| Follow-up messages                | Yes; a reply in the session continues the same conversation.                                                   |
| Live progress                     | Yes; thinking, tool calls, and the agent's task list appear on the session while it works.                     |
| Stop requests                     | Yes; Linear's stop request cancels the running turn and the agent confirms it stopped.                         |
| Deep link back to Manyfold        | Yes; the session carries an Open link to the full transcript.                                                  |
| Incoming and agent-produced files | No; agent activities are text only.                                                                            |
| User allowlist                    | Yes; Linear user IDs are checked before dispatch.                                                              |

## Prerequisites

- An existing Manyfold agent.
- Admin permission in the Linear workspace, which is required to install an application.

## Create the Linear application

1. In Linear, open **Settings → API → Applications** and create a new application. Its name and icon are how the agent appears in mention and filter menus, so keep them short and recognizable.
2. Enable **Webhooks** and select the **Agent session events** category. Leave the URL blank for now: it contains the Manyfold channel id, which does not exist yet.
3. Turn on **client credentials** if you want Manyfold to mint its own access token. Otherwise mint an app token yourself and keep it for step 3 below.
4. Copy the **client ID**, **client secret**, and **webhook signing secret**.

## Connect it to Manyfold

1. Go to **Settings → Channels → New channel** and choose **Linear**.
2. Pick the agent, then paste the client ID, client secret, and webhook signing secret. To use a token you minted yourself, paste it into **Access token** instead of the client pair — the signing secret is still required.
3. Optionally restrict who can drive the agent with **Allowed Linear user IDs**. Leave it empty to let anyone in the workspace mention it.
4. Save. Manyfold verifies the credentials, records the app identity, and activates the channel.
5. Copy the channel's **inbound URL** and paste it as the webhook URL in your Linear application.

## Use it

Mention the agent in an issue or comment, or delegate an issue to it. The agent acknowledges within a few seconds, then works. What you see on the session depends on the channel's **Progress** setting:

- **Activity** — thinking, each tool call, and the agent's task list as a session plan.
- **Final only** — the result, and nothing before it.

Send a stop request from the session menu to interrupt a run; the agent stops and posts a confirmation.

## Settings

| Setting                           | Effect                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed Linear user IDs           | Only these Linear users can drive the agent — every message, including follow-ups in an existing session, is checked against its author. Empty allows everyone in the workspace. Sessions started by Linear automations are always allowed. |
| Progress                          | Activity or Final only, as above.                                                                                                               |
| Send message context to the agent | Prepends the issue and sender metadata to each turn.                                                                                            |

## Troubleshooting

**The agent shows as unresponsive.** Linear expects a first activity within ten seconds. Check that the webhook URL in the Linear application matches the channel's inbound URL and that Agent session events are enabled.

**Nothing happens on mention.** Confirm the channel is Active in Manyfold, that the agent has access to the team the issue belongs to, and that the mentioning user is in the allowlist if you set one.

**Credentials stopped working.** Rotating the application's client secret invalidates existing app tokens. Re-enter the credentials in Manyfold; the signing secret must be re-entered along with them.

**The task list does not appear.** The Linear plan API is a preview. If Linear rejects the plan, Manyfold keeps the session's other progress and the reply, and drops only the list.

## Limits

- Agent activities are text only, so files are not exchanged in either direction.
- Progress is not streamed token by token; Linear has no message-edit API.
- Agent-wide commands such as `/model` are disabled from Linear.

## See also

- [Connect channels](/docs/channels/)
- [GitHub](/docs/channels/github/)
- [Create your first agent](/docs/create-agent/)
