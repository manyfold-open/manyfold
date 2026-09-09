import {
    DAEMON_FEATURE_AUTH_CONTEXT,
    INHERITED_AUTH,
    RUNTIME_AUTH_ERROR,
    isConfigurableFramework,
    type AgentModelConfigSource,
    type DaemonAuthContextRef,
    type RuntimeAuthSelection
} from '@manyfold/shared'
import type { Agent } from '@manyfold/db'

// Pure readers of an agent's auth selection, shared by the exec factory,
// the terminals and the model-config service (the service imports the
// factory, so the factory cannot import the service).

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null

// Mirrors AgentModelConfigService.configSourceFromAgent: the stored source
// when it is one the agent may use, else the runtime-kind default.
export const effectiveModelConfigSource = (
    agent: Pick<Agent, 'framework' | 'runtime' | 'extras'>
): AgentModelConfigSource => {
    const stored = asRecord(asRecord(agent.extras)?.modelConfig)?.source
    const runtimeLocalAllowed = isConfigurableFramework(agent.framework)
    if (stored === 'platform') return 'platform'
    if (stored === 'runtime-local' && runtimeLocalAllowed)
        return 'runtime-local'
    return agent.runtime === 'daemon' && runtimeLocalAllowed
        ? 'runtime-local'
        : 'platform'
}

export const runtimeAuthSelectionFor = (
    agent: Pick<
        Agent,
        | 'framework'
        | 'runtime'
        | 'extras'
        | 'runtimeAuthProfileId'
        | 'runtimeAuthBindingVersion'
    >
): RuntimeAuthSelection =>
    agent.runtimeAuthProfileId &&
    effectiveModelConfigSource(agent) === 'runtime-local'
        ? {
              mode: 'profile',
              profileId: agent.runtimeAuthProfileId,
              bindingVersion: agent.runtimeAuthBindingVersion
          }
        : INHERITED_AUTH

// The opaque ref a host resolves a profile context from. Null for an
// inherited selection, and for an agent whose framework has no profiles.
export const authContextRefFor = (
    agent: Pick<
        Agent,
        | 'framework'
        | 'runtime'
        | 'runtimeId'
        | 'extras'
        | 'runtimeAuthProfileId'
        | 'runtimeAuthBindingVersion'
    >
): DaemonAuthContextRef | null => {
    const selection = runtimeAuthSelectionFor(agent)
    if (selection.mode !== 'profile') return null
    if (!isConfigurableFramework(agent.framework) || !agent.runtimeId)
        return null
    return {
        framework: agent.framework,
        runtimeId: agent.runtimeId,
        profileId: selection.profileId,
        bindingVersion: selection.bindingVersion
    }
}

export class AuthContextUnsupportedError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
        super(`${code}: ${message}`)
        this.code = code
    }
}

// A profile-bound execution may only go to a host that honours the
// selection; anything else would run the native sign-in under a UI that
// names another account. `null` host = no host at all (sprite direct exec,
// pod exec).
export const assertHostHonoursAuthContext = (
    ref: DaemonAuthContextRef | null,
    host: { clientFeatures: string[] } | null,
    where: string
): void => {
    if (!ref) return
    if (!host)
        throw new AuthContextUnsupportedError(
            RUNTIME_AUTH_ERROR.contextUnsupported,
            `${where} cannot run under an auth profile; it needs a daemon or sprite runner with ${DAEMON_FEATURE_AUTH_CONTEXT}`
        )
    if (!host.clientFeatures.includes(DAEMON_FEATURE_AUTH_CONTEXT))
        throw new AuthContextUnsupportedError(
            RUNTIME_AUTH_ERROR.daemonUpgradeRequired,
            `${where} runs an mf CLI that predates auth profiles; run \`mf update\` on the host and restart the daemon`
        )
}
