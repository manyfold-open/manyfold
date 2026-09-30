import {
    SANDBOX_PREINSTALLED_FRAMEWORKS,
    compareSemverPrecedence,
    frameworkKind,
    frameworkUpgradeAvailable,
    frameworkUpgradeMode,
    listVersionedFrameworks,
    parseProbedSemver,
    supportsRuntime
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntimeSummary,
    FrameworkUpgradeMode,
    SandboxSummary
} from '@manyfold/shared'
import { sandboxFrameworkUpdateId } from '@/lib/updateCenter'

// One row of a sandbox's Runtimes list: a runtime, or a CLI already on the
// sandbox that no runtime has claimed yet. The image ships three, and the
// daemon reports whatever else it finds; either way the framework is there, so
// it reads as a runtime with no agents rather than as something to provision.
export interface SandboxRuntimeItem {
    framework: AgentFramework
    runtime: AgentRuntimeSummary | null
    version: string | null
    agentsCount: number
    // The Update Center row that carries this item's version.
    updateId: string
}

// Read when sorting, not at load: an edition registers its frameworks after
// core modules are evaluated (ADR-0034).
const byItemOrder = (): ((
    a: SandboxRuntimeItem,
    b: SandboxRuntimeItem
) => number) => {
    const order = new Map<AgentFramework, number>(
        listVersionedFrameworks().map((framework, index) => [framework, index])
    )
    const rank = (framework: AgentFramework): number =>
        order.get(framework) ?? Number.MAX_SAFE_INTEGER
    return (a, b) =>
        rank(a.framework) - rank(b.framework) ||
        (a.runtime?.createdAt ?? '').localeCompare(b.runtime?.createdAt ?? '')
}

const preinstalled = (framework: AgentFramework): boolean =>
    (SANDBOX_PREINSTALLED_FRAMEWORKS as readonly string[]).includes(framework)

// In the registry's order, claimed or not: the API returns runtimes in the
// order they last changed, and a row that jumped whenever its version did
// read as a different list. A sandbox that is not ready lists only its
// runtimes: nothing can be claimed on it yet.
export const sandboxRuntimeItems = (
    sandbox: SandboxSummary,
    runtimes: AgentRuntimeSummary[]
): SandboxRuntimeItem[] => {
    const items: SandboxRuntimeItem[] = runtimes.map((runtime) => ({
        framework: runtime.framework,
        runtime,
        version: runtime.frameworkVersion,
        agentsCount: runtime.agentsCount,
        updateId: `framework:${runtime.id}`
    }))
    if (sandbox.status !== 'ready') return items.sort(byItemOrder())
    const claimed = new Set(runtimes.map((runtime) => runtime.framework))
    // The daemon reports what `--version` printed ("2.1.251 (Claude Code)",
    // "codex-cli 0.151.0"); only the version in it compares with a catalog.
    const detected = new Map<AgentFramework, string | null>(
        sandbox.detectedFrameworks.map((d) => [
            d.framework,
            d.version ? parseProbedSemver(d.version) : null
        ])
    )
    const onSandbox = new Set<AgentFramework>([
        ...SANDBOX_PREINSTALLED_FRAMEWORKS,
        ...detected.keys()
    ])
    const unclaimed = [...onSandbox].filter(
        (framework) =>
            !claimed.has(framework) && supportsRuntime(framework, 'sprites')
    )
    for (const framework of unclaimed)
        items.push({
            framework,
            runtime: null,
            version: detected.get(framework) ?? null,
            agentsCount: 0,
            updateId: sandboxFrameworkUpdateId(sandbox.id, framework)
        })
    return items.sort(byItemOrder())
}

export interface SandboxInstallOption {
    framework: AgentFramework
    // The service framework already holding the sprite's one public port,
    // when that is what keeps this one out.
    blockedBy: AgentFramework | null
}

// What the "+" can install: every framework a sprite runs that is not on the
// sandbox yet.
export const sandboxInstallOptions = (
    sandbox: SandboxSummary,
    runtimes: AgentRuntimeSummary[]
): SandboxInstallOption[] => {
    if (sandbox.status !== 'ready') return []
    const present = new Set(
        sandboxRuntimeItems(sandbox, runtimes).map((item) => item.framework)
    )
    const serviceOccupant =
        runtimes.find(
            (runtime) =>
                frameworkKind(runtime.framework) === 'service' &&
                runtime.status !== 'failed'
        )?.framework ?? null
    return listVersionedFrameworks()
        .filter(
            (framework) =>
                supportsRuntime(framework, 'sprites') && !present.has(framework)
        )
        .map((framework) => ({
            framework,
            blockedBy:
                frameworkKind(framework) === 'service' &&
                serviceOccupant !== null
                    ? serviceOccupant
                    : null
        }))
}

// How an item moves to another version, the same way the Update Center moves
// it: through its runtime when there is one, otherwise in place on the
// sandbox for a CLI its image ships. null = not from here.
export type SandboxVersionChange =
    | { via: 'runtime'; runtimeId: string; mode: FrameworkUpgradeMode }
    | { via: 'sandbox' }

export const sandboxVersionChange = (
    item: SandboxRuntimeItem
): SandboxVersionChange | null => {
    if (item.runtime && item.runtime.status !== 'ready') return null
    const mode = frameworkUpgradeMode(item.framework)
    if (item.runtime && mode)
        return { via: 'runtime', runtimeId: item.runtime.id, mode }
    return preinstalled(item.framework) ? { via: 'sandbox' } : null
}

// The newer version the Update Center offers this item, or null. Only an item
// the Update Center lists gets one: a runtime, or a CLI the image ships.
export const sandboxItemUpdate = (
    item: SandboxRuntimeItem,
    latest: string | null
): string | null =>
    (item.runtime !== null || preinstalled(item.framework)) &&
    frameworkUpgradeAvailable(item.version, latest)
        ? latest
        : null

// The versions to pick from, newest first. The catalog's latest can be npm's
// own dist-tag and missing from its capped list; it is the obvious pick, so it
// is always there.
export const versionChoices = (
    versions: readonly string[],
    latest: string | null
): string[] =>
    [...new Set(latest ? [latest, ...versions] : versions)].sort(
        (a, b) => -(compareSemverPrecedence(a, b) ?? 0)
    )
