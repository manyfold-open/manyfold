---
title: Configure A2A permissions
description: Use the Manyfold UI to expose an Agent, authorize callers and targets, and verify the route before delegating work to another Agent.
order: 11
---
**Open Agent settings → A2A, enable exposure, grant the required caller or target, then verify the green reachable state.** Inbound answers "who can call this Agent?" Outbound answers "which Agents can this Agent call?"

Configure only the route that the workflow needs. Permission is directional and is not automatically shared with every Agent in the workspace.

## 1. Open Agent settings

From the main workspace, click the Agent information or open the three-dot menu beside the Agent name. Choose **Agent settings**.

![Manyfold workspace showing the Agent settings button](../../../assets/docs/a2a/a2a-01-agent-settings-demo.webp)

*Open Agent settings from the Agent information area.*

## 2. Enable A2A and understand the two directions

In the settings sidebar, scroll to the bottom and choose **A2A**, then enable exposure. The page shows the Agent Card, RPC endpoint, inbound callers, outbound targets, and activity.

![Manyfold A2A interoperability settings showing demo Agent exposure, inbound callers, outbound targets, and activity](../../../assets/docs/a2a/a2a-02-interoperability-demo.webp)

*The A2A settings page is the control plane for the Agent's authorized routes.*

- **Inbound, who can call this Agent**: Authorize a Manyfold Agent or an External client to call the current Agent. The current Agent is the target.
- **Outbound, which Agents this Agent calls**: Authorize the current Agent to call selected target Agents. The current Agent is the caller.

A successful route is **caller Outbound → target Inbound**. Both sides must agree; one side alone is not enough.

## 3. Authorize Agent peers or External clients

Use **Add caller** for inbound access and **Add target** for outbound access. Agent peers are existing Agents in the Manyfold workspace. External client is for an outside service that connects with A2A API credentials.

![Manyfold Add caller dialog listing Agent peers](../../../assets/docs/a2a/a2a-03-add-caller-peers-demo.webp)

*Select the peers that may call this Agent.*

![Manyfold Add caller dialog with selected Agent peers and Grant selected button](../../../assets/docs/a2a/a2a-04-grant-selected-demo.webp)

*Review the selection before granting access.*

Click **Grant selected**. The authorized identities then appear in the Inbound or Outbound dashboard.

![Manyfold A2A dashboard showing demo Agent inbound callers, outbound targets, and activity](../../../assets/docs/a2a/a2a-05-a2a-dashboard-demo.webp)

*Green reachable status confirms that the outbound route can be discovered.*

> **Security note:** Treat Agent Card URLs, RPC endpoints, External client credentials, and API tokens as secrets.

## 4. Return to the workspace and delegate

Select the caller Agent and send a bounded task. State the goal, scope, deliverable, and stop condition.

```text
Delegate to demo-researcher:
Goal: map the authentication flow.
Scope: inspect src/auth and related tests read-only; do not edit or commit.
Deliverable: file list, three risks, and a minimal fix proposal.
Stop condition: return the brief, then stop.
```

For the broader orchestration pattern, read [Design a multi-agent workflow](/docs/a2a/workflows/).

## Frequently asked questions

- **Does enabling A2A let every Agent call this Agent?**

  No. Exposure and caller grants are separate controls. Grant only the Agents or clients that the workflow requires.
- **Why is an outbound target not reachable?**

  Check that the target is exposed and that the target's Inbound section grants the caller. Then refresh the A2A status.

**Need the workflow design?** Read the [Multi-Agent A2A workflow guide](/docs/a2a/workflows/).

## See also

- [Manyfold A2A API documentation](/docs/api-a2a/)
- [mf CLI guide](/docs/cli/)
