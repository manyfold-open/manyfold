---
'@manyfold/api': minor
---

Every openclaw chat turn now speaks ACP. A sprite or k8s turn runs the
`openclaw acp` bridge in-box over the exec channel; a BYOD daemon turn runs it
against the host's own gateway. The OpenAI-compatible gateway POST and the
runner-held SSE variant that used to carry these turns are gone from openclaw
entirely — NarraNexus keeps both, unchanged, as their only framework.

`MF_OPENCLAW_ACP` is retired: it defaulted on and setting it now does nothing.
`MF_OPENCLAW_TURN_RPC` is unchanged and still gates NarraNexus's runner
transport.

Two accepted behaviour changes on BYOD daemons, both refusals that name their
own fix rather than silent fallbacks:

- A daemon whose `mf` CLI predates the openclaw ACP turn is refused with
  `openclaw_daemon_upgrade_required` — run `mf update` on that host and restart
  the daemon. The legacy `openclaw agent --local --json` spawn it used to fall
  back to has been removed.
- A daemon host with no openclaw gateway for the bridge to reach is refused
  with `openclaw_daemon_gateway_unavailable`, naming the port and
  `openclaw gateway start`. Manyfold still only discovers that gateway and
  never starts one. Because the daemon re-probes on its detect interval rather
  than per turn, an unreachable gateway is a retryable refusal while a missing
  configuration is not.

Openclaw sprite turns no longer bring up a runner. With the runner rollout at
`*` every openclaw turn was paying for a runner whose handle the ACP path then
ignored, and the turn was stamped with a resume reference no later recovery
could honour — a hello could terminalize a perfectly healthy turn. Resume for
openclaw is now daemon-only; a sprite or k8s turn reports
`openclaw_resume_unsupported`.
