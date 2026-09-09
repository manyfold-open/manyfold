---
'@manyfold/api': minor
---

Kubernetes coding agents can now run their chat turns through a daemon that
lives inside their own pod, instead of through `kubectl exec`.

Until now a pod ran no Manyfold process at all: every turn was driven from
outside over a pod exec stream. That had two costs. A turn could not survive an
API restart, because a pod exec has no sequence and no buffer to replay from.
And a pod's environment was written once, when it was provisioned — so an
agent's connected-service tokens and its own environment variables never
reached a Kubernetes agent, and the agent id baked into the pod named whichever
agent created it, which is the wrong one for every other agent sharing that pod.

The agent images now carry the `mf` binary, and the coding images start the
daemon as their main process. It enrols itself with a credential the platform
writes into the pod's environment, and registers as a platform-managed host
that stays out of quota and out of the user's machine list. From there a coding
turn takes exactly the same transport a sandbox runner turn already took, so it
becomes resumable and carries per-agent environment on every dispatch.

This is opt-in per agent through `MF_POD_RUNNER_AGENTS`, and every failure
degrades: no runner, an offline runner, a daemon below the supported CLI floor,
or a workspace that cannot be registered all fall back to the pod exec
transport, whose own behaviour is unchanged. (The pod's environment does gain
the daemon's registration keys, which every process in the container can see,
exactly as a sandbox runner's processes see its profile.) The daemon inside a
pod never updates itself — it reports its startup as unmanaged, which makes it
refuse remote upgrades and disable background updates, so its version moves
only when the image tag does.

Service frameworks are deliberately not included: their Kubernetes runtime is
the resident gateway itself, so a daemon beside it would be a second view of one
instance rather than a new transport.
