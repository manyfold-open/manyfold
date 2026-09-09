// Runner rollout lists. Each changes how a turn EXECUTES, so it opts in one
// agent at a time and an empty value means nothing changes for anyone; the
// single value '*' is the full-rollout switch. Read per call rather than at
// module load: the list is operational state, and freezing it at import time
// also makes it untestable.
//
// Two lists rather than one because the two managed runners come up by
// completely different means — the platform installs and launches a sprite's,
// while a pod's ships in the image — so an operator has to be able to roll
// them out, and back, independently.
import { frameworkCapability, type AgentFramework } from '@manyfold/shared'

const enabledFor = (raw: string | undefined, agentId: string): boolean => {
    const value = (raw ?? '').trim()
    if (value === '*') return true
    return value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .includes(agentId)
}

// Sprite turns dispatched through the sprite's own runner instead of a direct
// sprite exec.
export const spriteRunnerEnabledFor = (agentId: string): boolean =>
    enabledFor(process.env.MF_SPRITE_RUNNER_AGENTS, agentId)

// k8s turns dispatched through the daemon inside the pod instead of a pod exec.
// Consulted at dispatch AND by ExecDriverFactory, which otherwise cannot know
// whether the per-agent base env it would assemble for the transport swap is
// going to be used at all.
export const podRunnerEnabledFor = (agentId: string): boolean =>
    enabledFor(process.env.MF_POD_RUNNER_AGENTS, agentId)

// Which frameworks a pod runner carries at all: coding ones. A service
// framework's k8s runtime IS the resident gateway, so a daemon beside it would
// be a second surface on the same instance (the shape oss#192 unpicked for
// sprite runners), and its turn carries a `dir` the daemon's containment would
// have to accept — which needs a workspace contract k8s service runtimes do
// not have. One spelling, consumed by the provisioner (whether to bake the
// credential), dispatch (whether to look the runner up) and the exec-driver
// factory (whether to assemble the env the swap would carry), so the three can
// never disagree about which pods have a runner.
export const podRunnerCarries = (framework: AgentFramework): boolean =>
    frameworkCapability(framework).kind === 'coding'

// The dispatch-time decision in one place: this framework rides a pod runner
// AND this agent is inside the rollout. Dispatch policy, deliberately not a
// frameworkCapabilities field — the same layering argument the exec-env
// surface contract makes for its own table.
export const podRunnerAttemptedFor = (
    framework: AgentFramework,
    agentId: string
): boolean => podRunnerCarries(framework) && podRunnerEnabledFor(agentId)
