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
