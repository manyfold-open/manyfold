---
'@manyfold/api': minor
'@manyfold/web': minor
---

The chat sidebar now shows new chats as they appear, without a reload. Until
now the session list under each agent was fetched once per page load, so a chat
started anywhere other than the current browser tab stayed invisible — a Slack,
Discord, Telegram, Lark or GitHub thread reaching your agent, a scheduled
automation, or a call to the A2A or OpenAI-compatible API. Those chats now
arrive in the sidebar within about a second, and pick up their title as soon as
it is derived from the first message.
