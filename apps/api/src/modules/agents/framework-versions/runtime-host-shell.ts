import type { AgentRuntimeRow } from '@manyfold/db'
import type { AgentRuntime } from '@manyfold/shared'
import type {
    FrameworkExec,
    FrameworkExecRunResult
} from '@/modules/agents/adapters/framework-exec'

// Where a framework's CLI lives: any machine the platform provisioned
// (ADR-0036). The version probe and the in-place upgrade run the same login
// shell through the host's daemon on every provider; a local machine's CLI
// is the user's own to upgrade.
export const hostsFrameworkCli = (placement: AgentRuntime): boolean =>
    placement === 'sprites' || placement === 'k8s'

export const runOnRuntimeHost = async (
    exec: FrameworkExec,
    script: string,
    timeoutMs: number
): Promise<FrameworkExecRunResult> =>
    exec.run({ cmd: ['bash', '-lc', script], timeoutMs })

// The installation an upgrade lock covers (withRuntimeUpgradeLock): one
// machine, whichever runtime on it the agent addresses.
export const upgradeLockTarget = (
    runtime: AgentRuntimeRow,
    component: string
): { hostId: string; component: string } => ({
    hostId: runtime.hostId ?? runtime.id,
    component
})
