---
title: Model providers
description: Connect Anthropic, OpenAI, Google Gemini, OpenRouter, or managed model access.
order: 4
---
Model providers give agents access to the models they need. You can save provider credentials once and reuse them when creating agents.

## Supported providers

| Provider | Commonly used with |
| --- | --- |
| Anthropic | Claude Code |
| OpenAI | Codex |
| Google Gemini | Gemini CLI |
| OpenRouter | Model routing and compatible model access |

Your workspace may also have managed model access. If it does, the creation flow can offer provider options without requiring you to paste a personal API key.

## Use your own subscription

Claude Code, Codex, and Gemini CLI agents can run on the CLI's own sign-in — for example a Claude Pro/Max plan, a ChatGPT plan, or a Google account — instead of an API key.

1. When creating the agent, choose **Use your own subscription** in the model provider section.
2. After the agent is created, open its terminal from the chat page and complete the CLI's sign-in there.
3. Select **Refresh status** on the sign-in card. Once the sign-in is detected, the agent is ready to chat.

The sign-in stays inside the sandbox or computer the agent runs on; Manyfold stores no API key for the agent. On a sandbox it survives pause and resume and remains until the sandbox is deleted. Agents of the same framework sharing one sandbox also share its sign-in.

## Add a provider key

1. Open **Settings -> Model providers**.
2. Select the provider.
3. Add a label, such as `personal` or `team`.
4. Paste the API key.
5. Leave **Base URL** empty unless you use a compatible custom endpoint.
6. Test the connection.
7. Save the provider.

When you [create an agent](/docs/create-agent/), choose the saved provider from the creation flow.

## Provider labels

Use labels that explain ownership or budget boundaries:

- `personal`
- `engineering-team`
- `staging`
- `managed`

Avoid labels that include secret values, customer names, or one-off task names.

## Rotating keys

If a key is revoked or replaced:

1. Open the provider row in settings.
2. Paste the new key.
3. Test the connection.
4. Save the provider.
5. Retry any failed agent action.

Existing agents use the updated provider connection after it is saved.

## Troubleshooting

- **Test connection fails**: confirm the key belongs to the selected provider and has model access.
- **Agent creation asks for a provider**: add a compatible provider for the selected framework.
- **Model list is empty**: check account billing, model permissions, and any custom base URL.
- **Costs look unexpected**: review **Settings -> Usage** and confirm the agent is using the intended provider.

## See also

- [Create your first agent](/docs/create-agent/)
- [Use the workspace](/docs/workspace/)
- [FAQ](/docs/faq/)
