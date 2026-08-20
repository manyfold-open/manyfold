import { frameworkCapability } from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntimeSummary,
    SandboxSummary
} from '@manyfold/shared'

// A sprite exposes ONE public port, and every service-kind framework
// (openclaw / hermes / narranexus) serves its gateway on it, so a sandbox hosts
// at most one of them. Coding frameworks need no port and mix freely. Mirrors
// the API's gate in runtime-access.service.ts.
const isServiceFramework = (framework: AgentFramework): boolean =>
    frameworkCapability(framework).kind === 'service'

export interface SpriteReuseTarget {
    type: 'reuse'
    hostId: string | null
    runtime: AgentRuntimeSummary
}

export interface SpriteAttachTarget {
    type: 'attach'
    hostId: string
    name: string | null
    spriteName: string | null
    accountSlug: string | null
    frameworks: AgentFramework[]
    runtimeCount: number
}

// A sandbox the selected framework cannot join, kept in the list so the picker
// can say why instead of silently hiding the user's own sandbox.
export interface SpriteBlockedTarget {
    type: 'blocked'
    hostId: string
    name: string | null
    spriteName: string | null
    frameworks: AgentFramework[]
    reason: 'service-slot-taken'
    blockedBy: AgentFramework
}

export type SpriteTarget =
    | SpriteReuseTarget
    | SpriteAttachTarget
    | SpriteBlockedTarget

const isLive = (r: AgentRuntimeSummary): boolean =>
    r.status !== 'failed' && r.status !== 'stopped'

// From the user's sprite runtimes, derive the existing-sandbox targets for the
// selected framework. Every sandbox is a target — placement no longer filters by
// framework kind or host capacity:
//  - reuse: the sandbox already runs a ready instance of this framework -> add an
//    agent to it (credential-less addAgent).
//  - attach: the sandbox does not run this framework yet -> provision a new
//    instance onto it via createStream({ sandboxId: hostId }).
//  - blocked: this framework is service-kind and the sandbox already runs a
//    different service-kind framework (one public port per sprite).
// Reuse targets come first, then attach, then blocked. Sandboxes are derived from
// runtimes grouped by hostId; passing `sandboxes` (from sandboxes.list())
// additionally surfaces agent-less sandboxes (zero runtimes), which can host any
// framework.
export const computeSpriteTargets = (
    runtimes: AgentRuntimeSummary[],
    framework: AgentFramework,
    sandboxes: SandboxSummary[] = []
): SpriteTarget[] => {
    const sprites = runtimes.filter((r) => r.kind === 'sprites')
    // The friendly sandbox name lives only on SandboxSummary; runtimes carry the
    // technical spriteName. Look it up by host id so both attach branches can
    // lead with the name.
    const nameByHostId = new Map(sandboxes.map((s) => [s.id, s.name]))
    const reuse: SpriteReuseTarget[] = []
    const byHost = new Map<string, AgentRuntimeSummary[]>()
    for (const r of sprites) {
        if (!r.hostId) {
            if (r.framework === framework && r.status === 'ready')
                reuse.push({ type: 'reuse', hostId: null, runtime: r })
            continue
        }
        const group = byHost.get(r.hostId) ?? []
        group.push(r)
        byHost.set(r.hostId, group)
    }
    const attach: SpriteAttachTarget[] = []
    const blocked: SpriteBlockedTarget[] = []
    for (const [hostId, group] of byHost) {
        const matchingReady = group.find(
            (r) => r.framework === framework && r.status === 'ready'
        )
        if (matchingReady) {
            reuse.push({ type: 'reuse', hostId, runtime: matchingReady })
            continue
        }
        const live = group.filter(isLive)
        // A live instance that isn't ready yet (still provisioning) is neither a
        // reuse target nor a second-instance target — the API rejects both.
        if (live.some((r) => r.framework === framework)) continue
        const liveFrameworks = [...new Set(live.map((r) => r.framework))]
        const occupant = liveFrameworks.find(isServiceFramework)
        const base = {
            hostId,
            name: nameByHostId.get(hostId) ?? null,
            spriteName: group[0].spriteName,
            frameworks: liveFrameworks
        }
        if (isServiceFramework(framework) && occupant !== undefined)
            blocked.push({
                ...base,
                type: 'blocked',
                reason: 'service-slot-taken',
                blockedBy: occupant
            })
        else
            attach.push({
                ...base,
                type: 'attach',
                accountSlug: group[0].accountSlug,
                runtimeCount: live.length
            })
    }
    // Agent-less sandboxes (no sprite runtimes at all) only appear in the
    // sandboxes list, never in `runtimes`. Surface them as attach targets so a
    // bare sandbox can have its first instance provisioned onto it.
    for (const sandbox of sandboxes) {
        if (byHost.has(sandbox.id)) continue
        attach.push({
            type: 'attach',
            hostId: sandbox.id,
            name: sandbox.name,
            spriteName: sandbox.spriteName,
            accountSlug: sandbox.accountSlug,
            frameworks: [],
            runtimeCount: 0
        })
    }
    return [...reuse, ...attach, ...blocked]
}

export interface SpriteHostOccupancy {
    frameworks: AgentFramework[]
    count: number
}

// Per sprite host, the distinct live frameworks running on it. Drives the
// framework-logo indicator in the runtime picker.
export const spriteHostOccupancy = (
    runtimes: AgentRuntimeSummary[]
): Map<string, SpriteHostOccupancy> => {
    const byHost = new Map<string, AgentRuntimeSummary[]>()
    for (const r of runtimes) {
        if (r.kind !== 'sprites' || !r.hostId) continue
        const group = byHost.get(r.hostId) ?? []
        group.push(r)
        byHost.set(r.hostId, group)
    }
    const out = new Map<string, SpriteHostOccupancy>()
    for (const [hostId, group] of byHost) {
        const live = group.filter(isLive)
        out.set(hostId, {
            frameworks: [...new Set(live.map((r) => r.framework))],
            count: live.length
        })
    }
    return out
}

// Runtime auto-names are `{host}-{framework}` (e.g. `sandbox-012-claude-code`).
// The picker leads with the host, so strip the framework-key suffix for display.
export const stripFrameworkSuffix = (
    name: string,
    framework: AgentFramework
): string => {
    const suffix = `-${framework}`
    return name.length > suffix.length && name.endsWith(suffix)
        ? name.slice(0, -suffix.length)
        : name
}
