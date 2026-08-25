---
title: GitHub
description: Mention a Manyfold agent on GitHub issues and pull requests.
order: 17
---
Connect GitHub when you want an agent to answer where the work is filed. A dedicated GitHub App becomes the agent's identity: mention it in an issue or pull-request comment and it replies right there, streaming progress as a live-edited comment.

## What the channel supports

| Capability                        | Support                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Mentions on issues and PRs        | Yes; `@your-app` in an issue body, issue comment, or PR conversation comment starts a turn.                  |
| Label delegation                  | Yes; adding a configurable label to an issue delegates it without a mention.                                 |
| Follow-up messages                | Yes; mention the app again on the same issue to continue the conversation.                                   |
| Live progress                     | Yes; a working comment is edited in place while the agent runs (GitHub-native preview).                      |
| Acknowledgement                   | Yes; 👀 lands on the triggering comment, flipping to 🚀 or 😕 when the turn ends.                             |
| Stop requests                     | Yes; comment `@your-app /stop` to cancel the running turn.                                                   |
| Access control                    | Yes; author-association gate (owner/member/collaborator by default), plus optional login allow/operator lists. |
| Incoming and agent-produced files | No; comments are text only.                                                                                   |

## Prerequisites

- An existing Manyfold agent.
- Permission to create a GitHub App on your account or organization, and to install it on the target repositories.

## Connect it to Manyfold

1. Go to **Settings → Channels → New channel** and choose **GitHub**. Pick the agent, optionally restrict repositories, and save — no credentials yet.
2. On the channel page, enter your organization login (or leave it empty for a personal account) and press **Create GitHub App**. GitHub shows a pre-filled app creation page; confirm it. GitHub sends the credentials back to Manyfold automatically and the channel activates.
3. Press **Install on repositories** and choose the repositories the agent should answer on.

Prefer a hand-made app? Create one yourself with the `issues` and `issue_comment` webhook events, `Issues: Read and write` and `Pull requests: Read and write` permissions, the channel's inbound URL as the webhook URL, and a webhook secret — then paste the App ID, private key, and webhook secret into the channel's edit dialog and run **Register app**.

## Use it

Mention the app — `@your-app summarize the discussion` — in an issue body, issue comment, or PR conversation comment. The agent reacts with 👀, posts a working comment, edits it as it makes progress, and finishes with the reply. If you configured a delegation label, adding that label to an issue starts a turn with no mention needed.

The issue title, body, and recent comments ride along as context, so the agent sees the discussion even when it is only mentioned at the end.

To let the agent clone, push, or open pull requests, link a [GitHub Connection](/docs/workspace/) to the same agent — the channel app deliberately has no repository-contents access.

## Settings

| Setting                     | Effect                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repositories                | Only react on these `owner/repo` names. Empty = every repository the app is installed on.                                                        |
| Allowed GitHub logins       | When set, only these users can drive the agent — the association gate is skipped.                                                                |
| Allowed author associations | Who may drive the agent when no login allowlist is set. Defaults to `OWNER, MEMBER, COLLABORATOR`; add `NONE` to answer anyone on a public repo. |
| Operator GitHub logins      | Who may run agent-wide commands such as `/model`. Empty disables them from GitHub.                                                               |
| Delegation label            | Adding this label to an issue delegates it to the agent.                                                                                         |
| Progress mode               | Preview (live-edited comment), Activity (preview plus tool activity lines), or Final only.                                                       |
| Fresh final comment         | Post the final reply as a new comment instead of editing the preview — GitHub only notifies watchers about new comments, never edits.            |

## Troubleshooting

**Nothing happens on mention.** Confirm the channel is Active, the app is installed on that repository, the repository passes the channel's repository filter, and the author clears the association gate (a drive-by commenter on a public repo is rejected by default — the channel's deliveries list shows `association_not_allowed`).

**The app can't be assigned as the issue assignee.** GitHub does not support assigning App identities; use the delegation label instead.

**Watchers aren't notified of answers.** GitHub sends no notifications for comment edits. Turn on **Fresh final comment** so the reply lands as a new comment.

**Mentions in code blocks trigger nothing.** By design — fenced code, inline code, and quoted lines (email replies) are ignored when detecting mentions.

## Limits

- Comments are text only; files are not exchanged in either direction.
- Review-thread comments (inline code comments on a PR diff) are not yet handled; the PR conversation tab works.
- The channel app has no code access: repository write always comes from a GitHub Connection.

## See also

- [Connect channels](/docs/channels/)
- [Linear](/docs/channels/linear/)
- [Create your first agent](/docs/create-agent/)
