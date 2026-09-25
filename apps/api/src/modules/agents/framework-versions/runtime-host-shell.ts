import type { Agent, AgentRuntimeRow } from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSprite,
    type ExecResult
} from '@manyfold/sprites'
import { resolveAgentPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import type { KubernetesService } from '@/modules/k8s/kubernetes.service'
import type { PodExecFactory } from '@/modules/k8s/pod-exec'
import type { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'

export interface RuntimeHostShellDeps {
    accounts: SpritesAccountsService
    k8s?: KubernetesService
    podExec?: PodExecFactory
}

// Where a framework's CLI lives: a sprite, or a pod host (ADR-0035). The
// version probe and the in-place upgrade run the same login shell on either.
export const hostsFrameworkCli = (runtime: AgentRuntimeRow): boolean =>
    runtime.kind === 'sprites' || runtime.kind === 'k8s'

export const runOnRuntimeHost = async (
    deps: RuntimeHostShellDeps,
    agent: Agent,
    runtime: AgentRuntimeRow,
    script: string,
    timeoutMs: number
): Promise<ExecResult> => {
    if (runtime.kind === 'k8s') {
        if (!deps.k8s || !deps.podExec)
            throw new Error('pod exec is not wired')
        const pod = await resolveAgentPod(deps.k8s, runtime)
        return deps.podExec
            .forClient(pod.client, pod.namespace, pod.podName, pod.containerName)
            .run({ cmd: ['bash', '-lc', script], timeoutMs })
    }
    const spriteName = agent.spriteName ?? runtime.spriteName
    if (!spriteName) throw new Error(`agent ${agent.id} has no sprite`)
    const accountId = agent.accountId ?? runtime.accountId
    if (!accountId)
        throw new Error(`sprites agent ${agent.id} missing accountId`)
    const account = await deps.accounts.getById(accountId)
    if (!account) throw new Error(`sprites account ${accountId} not found`)
    const client = createSpritesClient({
        token: deps.accounts.decryptToken(account),
        accountSlug: account.slug
    })
    return execSprite(client, spriteName, {
        cmd: ['bash', '-lc', script],
        stdin: '',
        timeoutMs
    })
}

// The installation an upgrade lock covers (withRuntimeUpgradeLock): one sprite,
// or one pod host, whichever runtime on it the agent addresses.
export const upgradeLockTarget = (
    agent: Agent,
    runtime: AgentRuntimeRow,
    component: string
): { accountId: string; spriteName: string; component: string } =>
    runtime.kind === 'k8s'
        ? { accountId: 'pod-host', spriteName: runtime.hostId ?? '', component }
        : {
              accountId: agent.accountId ?? runtime.accountId ?? '',
              spriteName: agent.spriteName ?? runtime.spriteName ?? '',
              component
          }
