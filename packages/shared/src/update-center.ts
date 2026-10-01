import { MANYFOLD_CLI_USAGE_SKILL_ID } from './platformSkills'
import { SANDBOX_PREINSTALLED_FRAMEWORKS } from './daemon'
import type { DaemonHostSummary } from './daemon'
import { cliChannelOfVersion } from './cliVersion'
import { compareSemverPrecedence } from './semver'
import {
    findBlockedVersionRange,
    frameworkUpgradeAvailable,
    frameworkUpgradeMode,
    isVersionedFramework,
    parseProbedSemver,
    upgradesInPlace
} from './framework-versions'
import type {
    FrameworkUpgradeMode,
    FrameworkVersionCatalogEntry
} from './framework-versions'
import type {
    AgentRuntimeSummary,
    AgentSkillsGroup,
    CliVersionCatalog,
    PodHostSummary,
    SandboxSummary
} from './dtos'
import type { AgentFramework } from './frameworks/core'

// The Update Center's model, shared by the web page and `mf updates`: which
// rows exist, what blocks them, and the order a batch runs them in.

const hostKey = (hostId: string): string => `host:${hostId}`

export type UpdateKind = 'cli' | 'herdr' | 'framework' | 'cliUsage' | 'skill'

export const UPDATE_KINDS: readonly UpdateKind[] = [
    'cli',
    'herdr',
    'framework',
    'cliUsage',
    'skill'
]

export type UpdateSeverity = 'recommended' | 'required'

// Why a row cannot join a batch. null = the platform can drive this update
// remotely and the row is selectable.
//   manual   the update has to be run by a human on the machine itself
//   offline  the machine is reachable in principle but not right now
export type UpdateBlocker = 'manual' | 'offline'

export type UpdateExec =
    | {
          type: 'runtimeFramework'
          runtimeId: string
          framework: AgentFramework
          mode: FrameworkUpgradeMode
          targetVersion: string
      }
    // targetVersion null = omit the parameter and take the channel's latest,
    // which is what the endpoints do with an absent `targetVersion`.
    | { type: 'daemonCli'; hostId: string; targetVersion: string | null }
    | { type: 'sandboxCli'; hostId: string; targetVersion: string | null }
    // One of a sandbox's pre-installed CLIs its runtime cannot move: the
    // sandbox moves it in place, runtime or not.
    | {
          type: 'sandboxFramework'
          hostId: string
          framework: AgentFramework
          targetVersion: string
      }
    // A cloud computer's daemon updates itself; the host restarts it.
    | { type: 'podHostCli'; podHostId: string }
    // herdr rides herdr's own updater, always to its latest (ADR-0031).
    | { type: 'daemonHerdr'; hostId: string }
    | { type: 'sandboxHerdr'; hostId: string }
    | { type: 'skillInstall'; skillId: string; agentId: string }
    // Nothing the platform can run: either a copy-a-command guide for the
    // framework, or a link to wherever the human does it.
    | { type: 'none'; guideFramework: AgentFramework | null; href: string | null }

export type UpdateTargetKind = 'daemon' | 'sandbox' | 'k8s' | 'agent'

export interface UpdateRow {
    id: string
    kind: UpdateKind
    subjectLabel: string
    // Drives the row's logo. null for mf CLI rows, which belong to a machine
    // rather than to any one framework.
    framework: AgentFramework | null
    targetKind: UpdateTargetKind
    // One machine is one host (ADR-0037): `host:<hostId>` for anything on a
    // machine, `agent:<id>` for a skill, `runtime:<id>` for an external one.
    targetKey: string
    targetLabel: string
    installedVersion: string | null
    latestVersion: string | null
    // Versions this row may be pointed at, newest-first. Empty = not a choice
    // at all, so the row can only go to `latestVersion`.
    targetChoices: string[]
    severity: UpdateSeverity
    blockedReason: string | null
    blocker: UpdateBlocker | null
    materialization?: { status: 'installing' | 'failed'; error: string | null }
    exec: UpdateExec
}

export interface UpdateCenterInputs {
    daemonHosts: DaemonHostSummary[]
    sandboxes: SandboxSummary[]
    podHosts: PodHostSummary[]
    runtimes: AgentRuntimeSummary[]
    frameworkCatalog: FrameworkVersionCatalogEntry[]
    skillGroups: AgentSkillsGroup[]
    cliVersions: CliVersionCatalog
}

export const emptyUpdateCenterInputs: UpdateCenterInputs = {
    daemonHosts: [],
    sandboxes: [],
    podHosts: [],
    runtimes: [],
    frameworkCatalog: [],
    skillGroups: [],
    cliVersions: { stable: [], dev: [] }
}

// A skill's revision is a git commit SHA; the whole thing is unreadable in a
// table cell and only the leading characters carry information.
export const shortRevision = (revision: string): string => revision.slice(0, 7)

const kindOrder: Record<UpdateKind, number> = {
    cli: 0,
    herdr: 1,
    framework: 2,
    cliUsage: 3,
    skill: 4
}

const compareRows = (a: UpdateRow, b: UpdateRow): number => {
    if (a.severity !== b.severity) return a.severity === 'required' ? -1 : 1
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind]
    const byTarget = a.targetLabel.localeCompare(b.targetLabel)
    if (byTarget !== 0) return byTarget
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// mf CLI targets for a daemon. The channel comes from the version string, and
// the other channel is only merged in when the daemon itself reports it can
// cross over — the same pair of conditions resolveDaemonTarget enforces
// server-side, so an option the picker offers can never come back a 400.
// Own channel first rather than strictly newest-first: the two channels
// version independently, so interleaving them would read as one broken
// sequence, and the far channel is a local/staging escape hatch either way.
const daemonCliTargets = (
    host: DaemonHostSummary,
    catalog: CliVersionCatalog
): string[] => {
    const onDev = cliChannelOfVersion(host.cliVersion) === 'dev'
    const own = onDev ? catalog.dev : catalog.stable
    if (!host.canCrossChannelUpgrade) return own
    return [...own, ...(onDev ? catalog.stable : catalog.dev)]
}

const cliRows = (inputs: UpdateCenterInputs): UpdateRow[] => {
    const rows: UpdateRow[] = []
    for (const host of inputs.daemonHosts) {
        if (!host.updateAvailable && !host.needsUpgrade) continue
        // Offline is checked first: the API rejects an upgrade for an offline
        // host before it ever looks at canRemoteUpgrade, so reporting the
        // startup-method reason for an unreachable machine would name a
        // blocker the user cannot act on yet.
        const blocker: UpdateBlocker | null = !host.online
            ? 'offline'
            : host.canRemoteUpgrade
              ? null
              : 'manual'
        rows.push({
            id: `cli:daemon:${host.id}`,
            kind: 'cli',
            subjectLabel: 'mf CLI',
            framework: null,
            targetKind: 'daemon',
            targetKey: hostKey(host.id),
            targetLabel: host.name,
            installedVersion: host.cliVersion,
            latestVersion: host.latestCliVersion,
            targetChoices:
                blocker === null ? daemonCliTargets(host, inputs.cliVersions) : [],
            severity: host.needsUpgrade ? 'required' : 'recommended',
            blockedReason: null,
            blocker,
            exec:
                blocker === null
                    ? {
                          type: 'daemonCli',
                          hostId: host.id,
                          targetVersion: null
                      }
                    : {
                          type: 'none',
                          guideFramework: null,
                          href: '/settings/runtimes/local-daemons'
                      }
        })
    }
    for (const sandbox of inputs.sandboxes) {
        if (!sandbox.cliUpdateAvailable) continue
        rows.push({
            id: `cli:sandbox:${sandbox.id}`,
            kind: 'cli',
            subjectLabel: 'mf CLI',
            framework: null,
            targetKind: 'sandbox',
            targetKey: hostKey(sandbox.id),
            targetLabel: sandbox.name,
            installedVersion: sandbox.cliVersion,
            latestVersion: sandbox.latestCliVersion,
            // No channel constraint here, unlike a daemon: the sprite has no
            // installed-from channel to stay on, so upgradeCli only checks
            // that the version is one we list.
            targetChoices: [
                ...inputs.cliVersions.stable,
                ...inputs.cliVersions.dev
            ],
            severity: 'recommended',
            blockedReason: null,
            blocker: null,
            exec: {
                type: 'sandboxCli',
                hostId: sandbox.id,
                targetVersion: null
            }
        })
    }
    for (const host of inputs.podHosts) {
        if (!host.cliUpdateAvailable) continue
        rows.push({
            id: `cli:podHost:${host.id}`,
            kind: 'cli',
            subjectLabel: 'mf CLI',
            framework: null,
            targetKind: 'k8s',
            targetKey: hostKey(host.id),
            targetLabel: host.name,
            installedVersion: host.cliVersion,
            latestVersion: host.latestCliVersion,
            // To the daemon's own channel's latest: it is a daemon, and the
            // channel rules a daemon's update obeys apply to it.
            targetChoices: [],
            severity: 'recommended',
            blockedReason: null,
            blocker:
                host.status === 'ready' && host.daemonOnline ? null : 'offline',
            exec: { type: 'podHostCli', podHostId: host.id }
        })
    }
    return rows
}

// herdr on each machine and inside each sandbox (ADR-0031). A daemon only
// offers it while online; a sandbox without herdr gets an install row
// (installed null), since the platform can put it there.
const herdrRows = (inputs: UpdateCenterInputs): UpdateRow[] => {
    const rows: UpdateRow[] = []
    for (const host of inputs.daemonHosts) {
        if (!host.herdrUpdateAvailable) continue
        const blocker: UpdateBlocker | null = host.online ? null : 'offline'
        rows.push({
            id: `herdr:daemon:${host.id}`,
            kind: 'herdr',
            subjectLabel: 'herdr',
            framework: null,
            targetKind: 'daemon',
            targetKey: hostKey(host.id),
            targetLabel: host.name,
            installedVersion: host.herdrVersion,
            latestVersion: host.latestHerdrVersion,
            targetChoices: [],
            severity: 'recommended',
            blockedReason: null,
            blocker,
            exec:
                blocker === null
                    ? { type: 'daemonHerdr', hostId: host.id }
                    : {
                          type: 'none',
                          guideFramework: null,
                          href: '/settings/runtimes/local-daemons'
                      }
        })
    }
    for (const sandbox of inputs.sandboxes) {
        if (!sandbox.herdrUpdateAvailable) continue
        rows.push({
            id: `herdr:sandbox:${sandbox.id}`,
            kind: 'herdr',
            subjectLabel: 'herdr',
            framework: null,
            targetKind: 'sandbox',
            targetKey: hostKey(sandbox.id),
            targetLabel: sandbox.name,
            installedVersion: sandbox.herdrVersion,
            latestVersion: sandbox.latestHerdrVersion,
            targetChoices: [],
            severity: 'recommended',
            blockedReason: null,
            blocker: null,
            exec: { type: 'sandboxHerdr', hostId: sandbox.id }
        })
    }
    return rows
}

const runtimeTargetKind = (runtime: AgentRuntimeSummary): UpdateTargetKind => {
    switch (runtime.kind) {
        case 'daemon':
            return 'daemon'
        case 'k8s':
            return 'k8s'
        default:
            return 'sandbox'
    }
}

const runtimeTarget = (
    runtime: AgentRuntimeSummary
): { key: string; label: string } =>
    runtime.hostId
        ? {
              key: hostKey(runtime.hostId),
              label: runtime.hostName ?? runtime.name
          }
        : { key: `runtime:${runtime.id}`, label: runtime.name }

// Framework targets: whatever the catalog offers that is a strict upgrade over
// what is installed. The server has already withheld blocked ranges and
// unadmitted prereleases from `versions`, so no further filtering belongs here.
//
// `latest` is folded in because it does not have to be a member of `versions`:
// it can come from npm's own `latest` dist-tag, and `versions` is capped. It is
// the row's default target, so a picker that did not offer it would open on a
// value it cannot show.
export const frameworkCatalogVersions = (
    entry: FrameworkVersionCatalogEntry
): string[] =>
    entry.latest !== null && !entry.versions.includes(entry.latest)
        ? [...entry.versions, entry.latest].sort(
              (a, b) => -(compareSemverPrecedence(a, b) ?? 0)
          )
        : entry.versions

const frameworkTargets = (
    installed: string | null,
    entry: FrameworkVersionCatalogEntry
): string[] =>
    frameworkCatalogVersions(entry).filter((version) =>
        frameworkUpgradeAvailable(installed, version)
    )

// One row per runtime, never per agent: the installed version lives on the
// runtime, so N agents sharing a sprite would otherwise produce N rows that all
// drive the same single upgrade.
const frameworkRows = (
    inputs: UpdateCenterInputs,
    frameworkLabel: (framework: AgentFramework) => string
): UpdateRow[] => {
    const catalog = new Map(
        inputs.frameworkCatalog.map((entry) => [
            entry.framework as AgentFramework,
            entry
        ])
    )
    const rows: UpdateRow[] = []
    for (const runtime of inputs.runtimes) {
        if (!isVersionedFramework(runtime.framework)) continue
        const entry = catalog.get(runtime.framework)
        if (!entry?.latest) continue
        if (!frameworkUpgradeAvailable(runtime.frameworkVersion, entry.latest))
            continue

        const mode = frameworkUpgradeMode(runtime.framework)
        const target = runtimeTarget(runtime)
        // A cloud computer upgrades an npm or release-binary CLI in place, as
        // a sprite does; its rebuilt service frameworks are not on it yet
        // (ADR-0035).
        const onOurs =
            runtime.kind === 'sprites' ||
            (runtime.kind === 'k8s' && upgradesInPlace(mode))
        const remote = onOurs && mode !== null
        // A sandbox still moves the CLIs its image ships in place when the
        // runtime cannot.
        const inPlace =
            !remote &&
            runtime.kind === 'sprites' &&
            runtime.hostId !== null &&
            preinstalledOnSandbox(runtime.framework)
        const blocker: UpdateBlocker | null =
            remote || inPlace ? null : 'manual'
        const blocked = findBlockedVersionRange(
            runtime.frameworkVersion,
            entry.blocked
        )
        rows.push({
            id: `framework:${runtime.id}`,
            kind: 'framework',
            subjectLabel: frameworkLabel(runtime.framework),
            framework: runtime.framework,
            targetKind: runtimeTargetKind(runtime),
            targetKey: target.key,
            targetLabel: target.label,
            installedVersion: runtime.frameworkVersion,
            latestVersion: entry.latest,
            targetChoices:
                (remote && mode) || inPlace
                    ? frameworkTargets(runtime.frameworkVersion, entry)
                    : [],
            severity: blocked ? 'required' : 'recommended',
            blockedReason: blocked?.reason ?? null,
            blocker,
            exec:
                remote && mode
                    ? {
                          type: 'runtimeFramework',
                          runtimeId: runtime.id,
                          framework: runtime.framework,
                          mode,
                          targetVersion: entry.latest
                      }
                    : inPlace
                      ? {
                            type: 'sandboxFramework',
                            hostId: runtime.hostId as string,
                            framework: runtime.framework,
                            targetVersion: entry.latest
                        }
                      : {
                            type: 'none',
                            // A daemon runtime runs on the user's own machine,
                            // so the only honest affordance is the command to
                            // run there; anything else needs the runtime page.
                            guideFramework:
                                runtime.kind === 'daemon'
                                    ? runtime.framework
                                    : null,
                            href:
                                runtime.kind === 'daemon'
                                    ? null
                                    : `/settings/runtimes/${runtime.id}`
                        }
        })
    }
    return rows
}

const preinstalledOnSandbox = (framework: AgentFramework): boolean =>
    (SANDBOX_PREINSTALLED_FRAMEWORKS as readonly string[]).includes(framework)

export const sandboxFrameworkUpdateId = (
    hostId: string,
    framework: AgentFramework
): string => `framework:host:${hostId}:${framework}`

// A sandbox's pre-installed CLIs that no runtime has claimed yet. They are on
// the machine and can fall behind like any other, but only the sandbox lists
// them, so without these rows an outdated one had nowhere to be updated.
const sandboxFrameworkRows = (
    inputs: UpdateCenterInputs,
    frameworkLabel: (framework: AgentFramework) => string
): UpdateRow[] => {
    const catalog = new Map(
        inputs.frameworkCatalog.map((entry) => [entry.framework, entry])
    )
    const claimed = new Set(
        inputs.runtimes.map(
            (runtime) => `${runtime.hostId}:${runtime.framework}`
        )
    )
    const rows: UpdateRow[] = []
    for (const sandbox of inputs.sandboxes) {
        if (sandbox.status !== 'ready') continue
        for (const detected of sandbox.detectedFrameworks) {
            const { framework } = detected
            // What `--version` printed, e.g. "2.1.251 (Claude Code)".
            const version = detected.version
                ? parseProbedSemver(detected.version)
                : null
            if (!preinstalledOnSandbox(framework)) continue
            if (claimed.has(`${sandbox.id}:${framework}`)) continue
            const entry = catalog.get(framework)
            if (!entry?.latest) continue
            if (!frameworkUpgradeAvailable(version, entry.latest)) continue
            const blocked = findBlockedVersionRange(version, entry.blocked)
            rows.push({
                id: sandboxFrameworkUpdateId(sandbox.id, framework),
                kind: 'framework',
                subjectLabel: frameworkLabel(framework),
                framework,
                targetKind: 'sandbox',
                targetKey: hostKey(sandbox.id),
                targetLabel: sandbox.name,
                installedVersion: version,
                latestVersion: entry.latest,
                targetChoices: frameworkTargets(version, entry),
                severity: blocked ? 'required' : 'recommended',
                blockedReason: blocked?.reason ?? null,
                blocker: null,
                exec: {
                    type: 'sandboxFramework',
                    hostId: sandbox.id,
                    framework,
                    targetVersion: entry.latest
                }
            })
        }
    }
    return rows
}

export const skillUpdateId = (agentId: string, skillId: string): string =>
    `${skillId === MANYFOLD_CLI_USAGE_SKILL_ID ? 'cliUsage' : 'skill'}:${agentId}:${skillId}`

const skillRows = (inputs: UpdateCenterInputs): UpdateRow[] => {
    const rows: UpdateRow[] = []
    for (const group of inputs.skillGroups)
        for (const skill of group.skills) {
            if (skill.readonly) continue
            const materialization: UpdateRow['materialization'] =
                skill.materializeStatus === 'installing' ||
                skill.materializeStatus === 'failed'
                    ? {
                          status: skill.materializeStatus,
                          error: skill.materializeError ?? null
                      }
                    : undefined
            if (
                !materialization &&
                (!skill.installedRevision ||
                    !skill.latestRevision ||
                    skill.installedRevision === skill.latestRevision)
            )
                continue
            const kind: UpdateKind =
                skill.skillId === MANYFOLD_CLI_USAGE_SKILL_ID
                    ? 'cliUsage'
                    : 'skill'
            rows.push({
                id: skillUpdateId(skill.agentId, skill.skillId),
                kind,
                subjectLabel: skill.name,
                framework: null,
                targetKind: 'agent',
                targetKey: `agent:${skill.agentId}`,
                targetLabel: group.agent.name,
                // Revisions on both sides even when the install recorded a
                // version: the catalog only knows the latest as a revision, and
                // an arrow between "0.3.1" and a commit hash reads as if the
                // version were being replaced by one.
                installedVersion: skill.installedRevision
                    ? shortRevision(skill.installedRevision)
                    : null,
                latestVersion: skill.latestRevision
                    ? shortRevision(skill.latestRevision)
                    : null,
                ...(materialization ? { materialization } : {}),
                // No version catalog for a skill: both sides are the one
                // revision each side happens to be on, so there is nothing to
                // choose between.
                targetChoices: [],
                severity: 'recommended',
                blockedReason: null,
                blocker: null,
                exec: {
                    type: 'skillInstall',
                    skillId: skill.skillId,
                    agentId: skill.agentId
                }
            })
        }
    return rows
}

export const buildUpdateRows = (
    inputs: UpdateCenterInputs,
    frameworkLabel: (framework: AgentFramework) => string
): UpdateRow[] =>
    [
        ...cliRows(inputs),
        ...herdrRows(inputs),
        ...frameworkRows(inputs, frameworkLabel),
        ...sandboxFrameworkRows(inputs, frameworkLabel),
        ...skillRows(inputs)
    ].sort(compareRows)

export const countUpdates = (rows: UpdateRow[]): number => rows.length

export type UpdateStatus = 'required' | 'ready' | 'manual' | 'offline'

// Severity outranks the blocker: a machine below the minimum version is broken
// today, and saying only "update by hand" would file the most urgent row under
// the calmest heading. How it gets updated is shown alongside, not instead.
export const displayStatus = (row: UpdateRow): UpdateStatus => {
    if (row.severity === 'required') return 'required'
    if (row.blocker === 'offline') return 'offline'
    if (row.blocker !== null) return 'manual'
    return 'ready'
}

// The label axis, and it ranks the two facts the other way round from
// displayStatus on purpose. Grouping needs severity on top so the most urgent
// row cannot land under the calmest heading; a tag does not, because its tone
// already carries the urgency — which leaves the label free to say the thing
// tone cannot, namely where the row is stuck.
export const blockerStatus = (row: UpdateRow): UpdateStatus =>
    row.blocker === 'offline'
        ? 'offline'
        : row.blocker !== null
          ? 'manual'
          : row.severity === 'required'
            ? 'required'
            : 'ready'

// What a batch can run from here: nothing blocks it, and a skill is not still
// materializing from an earlier install.
export const isRunnableUpdate = (row: UpdateRow): boolean =>
    row.blocker === null && row.materialization?.status !== 'installing'

const kindParams: Record<UpdateKind, string> = {
    cli: 'cli',
    herdr: 'herdr',
    framework: 'framework',
    cliUsage: 'cli-usage',
    skill: 'skill'
}

export const kindParamOf = (kind: UpdateKind): string => kindParams[kind]

export const parseKindParam = (value: string | null): UpdateKind | null => {
    for (const [kind, param] of Object.entries(kindParams))
        if (param === value) return kind as UpdateKind
    return null
}

export const filterRowsByKind = (
    rows: UpdateRow[],
    kind: UpdateKind | null
): UpdateRow[] => (kind === null ? rows : rows.filter((r) => r.kind === kind))

// The server allows 5 daemon upgrades per 60s per actor and does not forward a
// retry hint: the rate limiter puts `retryAfter` at the top level of the body,
// where the global exception filter (which only passes through code, message
// and details) drops it, and the Retry-After header is emitted only for the
// differently-named `retryAfterSec`. So a queue paces itself to the same
// window rather than reading a number that never arrives.
export const DAEMON_UPGRADES_PER_WINDOW = 5
export const DAEMON_UPGRADE_WINDOW_MS = 62_000

export type BatchStep =
    // One call covers many agents, so selecting the same skill on twelve agents
    // is twelve rows but one request.
    | { type: 'skillBatch'; skillId: string; agentIds: string[]; rowIds: string[] }
    | {
          type: 'framework'
          rowId: string
          runtimeId: string
          framework: AgentFramework
          mode: FrameworkUpgradeMode
          targetVersion: string
      }
    | { type: 'daemonCli'; rowId: string; hostId: string; targetVersion: string | null }
    | {
          type: 'sandboxCli'
          rowId: string
          hostId: string
          targetVersion: string | null
      }
    | {
          type: 'sandboxFramework'
          rowId: string
          hostId: string
          framework: AgentFramework
          targetVersion: string
      }
    | { type: 'podHostCli'; rowId: string; podHostId: string }
    | { type: 'daemonHerdr'; rowId: string; hostId: string }
    | { type: 'sandboxHerdr'; rowId: string; hostId: string }

export const SKILL_INSTALL_BATCH_LIMIT = 50

const stepOrder = (step: BatchStep): number => {
    switch (step.type) {
        case 'skillBatch':
            return 0
        case 'sandboxCli':
        case 'sandboxHerdr':
            return 1
        case 'daemonCli':
        case 'daemonHerdr':
        case 'podHostCli':
            return 2
        case 'sandboxFramework':
            return 3
        case 'framework':
            // A rebuild takes minutes while every other step takes seconds, so
            // it goes last: a queue that starts with one holds up everything
            // the user could otherwise have seen finish.
            return step.mode === 'rebuild' ? 4 : 3
    }
}

// Steps run one at a time, so the order here is the order the user watches them
// complete in. Rows the platform cannot drive are dropped rather than failed —
// they are never selectable in the first place.
//
// `targets` is the picked-version overlay, keyed by row id, and it is a
// parameter rather than part of the row so that choosing a version does not
// invalidate buildUpdateRows' memo and rebuild the whole table.
export const planBatch = (
    rows: UpdateRow[],
    targets: Record<string, string> = {}
): BatchStep[] => {
    const steps: BatchStep[] = []
    const skillOrder: string[] = []
    const bySkill = new Map<string, { agentIds: string[]; rowIds: string[] }>()

    for (const row of rows) {
        if (!isRunnableUpdate(row)) continue
        const picked = targets[row.id] ?? null
        switch (row.exec.type) {
            case 'skillInstall': {
                const { skillId, agentId } = row.exec
                let bucket = bySkill.get(skillId)
                if (!bucket) {
                    bucket = { agentIds: [], rowIds: [] }
                    bySkill.set(skillId, bucket)
                    skillOrder.push(skillId)
                }
                bucket.agentIds.push(agentId)
                bucket.rowIds.push(row.id)
                break
            }
            case 'daemonCli':
                steps.push({
                    type: 'daemonCli',
                    rowId: row.id,
                    hostId: row.exec.hostId,
                    targetVersion: picked ?? row.exec.targetVersion
                })
                break
            case 'sandboxCli':
                steps.push({
                    type: 'sandboxCli',
                    rowId: row.id,
                    hostId: row.exec.hostId,
                    targetVersion: picked ?? row.exec.targetVersion
                })
                break
            case 'podHostCli':
                steps.push({
                    type: 'podHostCli',
                    rowId: row.id,
                    podHostId: row.exec.podHostId
                })
                break
            case 'daemonHerdr':
                steps.push({
                    type: 'daemonHerdr',
                    rowId: row.id,
                    hostId: row.exec.hostId
                })
                break
            case 'sandboxHerdr':
                steps.push({
                    type: 'sandboxHerdr',
                    rowId: row.id,
                    hostId: row.exec.hostId
                })
                break
            case 'sandboxFramework':
                steps.push({
                    type: 'sandboxFramework',
                    rowId: row.id,
                    hostId: row.exec.hostId,
                    framework: row.exec.framework,
                    targetVersion: picked ?? row.exec.targetVersion
                })
                break
            case 'runtimeFramework':
                steps.push({
                    type: 'framework',
                    rowId: row.id,
                    runtimeId: row.exec.runtimeId,
                    framework: row.exec.framework,
                    mode: row.exec.mode,
                    targetVersion: picked ?? row.exec.targetVersion
                })
                break
            case 'none':
                break
        }
    }

    for (const skillId of skillOrder) {
        const bucket = bySkill.get(skillId)
        if (!bucket) continue
        for (
            let i = 0;
            i < bucket.agentIds.length;
            i += SKILL_INSTALL_BATCH_LIMIT
        )
            steps.push({
                type: 'skillBatch',
                skillId,
                agentIds: bucket.agentIds.slice(
                    i,
                    i + SKILL_INSTALL_BATCH_LIMIT
                ),
                rowIds: bucket.rowIds.slice(i, i + SKILL_INSTALL_BATCH_LIMIT)
            })
    }

    return steps.sort((a, b) => stepOrder(a) - stepOrder(b))
}
