import type { AgentFramework, SandboxSummary } from '@manyfold/shared'
import { compareSemverPrecedence, frameworkCapability } from '@manyfold/shared'

// What the create form says about the picked framework on the picked sandbox:
// absent, behind the catalog, current, or installed with no catalog to judge
// it by. A version the comparer cannot order (a stamp, a dev build) counts as
// current: the form must never offer an "upgrade" it cannot describe.
export type FrameworkOnHostState =
    | { kind: 'missing' }
    | { kind: 'unknown'; installed: string }
    | { kind: 'current'; installed: string }
    | { kind: 'outdated'; installed: string; latest: string }

export const frameworkOnHostState = (
    installed: string | null,
    latest: string | null
): FrameworkOnHostState => {
    if (!installed) return { kind: 'missing' }
    if (!latest) return { kind: 'unknown', installed }
    const order = compareSemverPrecedence(installed, latest)
    if (order === null || order >= 0) return { kind: 'current', installed }
    return { kind: 'outdated', installed, latest }
}

// The version the sandbox's last probe saw for a framework, if any.
export const installedFrameworkVersion = (
    sandbox: Pick<SandboxSummary, 'detectedFrameworks'> | null | undefined,
    framework: string
): string | null =>
    sandbox?.detectedFrameworks.find((f) => f.framework === framework)
        ?.version ?? null

// A sprite exposes one public port, and every service framework (OpenClaw,
// Hermes, NarraNexus) serves its gateway on it, so a sandbox holds at most one
// of them: the one already there, if any. Coding CLIs need no port and mix
// freely. Mirrors the API's gate in runtime-access.service.ts.
export const serviceSlotOccupant = (
    present: readonly AgentFramework[]
): AgentFramework | null =>
    present.find((f) => frameworkCapability(f).kind === 'service') ?? null
