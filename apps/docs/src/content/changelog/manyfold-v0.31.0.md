---
version: '0.31.0'
date: '2026-07-01'
---

## Manyfold — Native sign-in, account connections, and chat file attachments

This release introduces a self-hosted sign-in experience, account-level connections your agents can use, and file attachments across chat — plus per-agent MCP tool configuration.

### Highlights

- **A new way to sign in.** Manyfold now runs sign-in itself: email and password (with email verification), Google, and single sign-on (OIDC), all configurable by your workspace admins. Sessions are issued and revoked by Manyfold directly.
- **Account connections.** Link your GitHub, Cloudflare, and Composio accounts once, and Manyfold makes them available inside your agents — GitHub and Cloudflare as credentials, Composio as a set of ready-to-use tools.
- **File attachments in chat.** Attach files in the chat composer, send file and image parts through the OpenAI-compatible API, and upload files to Dify chat agents.
- **Per-agent MCP tools.** Choose which MCP tools an agent can use, per scope, right from the agent detail page.

### Notes

- **You may need to sign in again.** As part of moving to the new sign-in, existing sessions were reset. On the sign-in page, use **Forgot password** to set an email password, or sign in with Google/SSO once your admin has enabled it. If you run into trouble, reach out to your workspace admin.
