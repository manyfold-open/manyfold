import {
    MANYFOLD_CLI_USAGE_SKILL_ID,
    findBlockedVersionRange,
    frameworkUpgradeAvailable,
    frameworkUpgradeMode,
    isVersionedFramework
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntimeSummary,
    AgentSkillsGroup,
    DaemonHostSummary,
    FrameworkUpgradeMode,
    FrameworkVersionCatalogEntry,
    SandboxSummary
} from '@manyfold/shared'

export type UpdateKind = 'cli' | 'framework' | 'cliUsage' | 'skill'
export type UpdateSeverity = 'recommended' | 'required'

// Why a row cannot join a batch. null = the platform can drive this update
// remotely and the row is selectable.
//   manual   the update has to be run by a human on the machine itself
//   offline  the machine is reachable in principle but not right now
//   noAgent  a sprite runtime with no agent to address the upgrade endpoint by
export type UpdateBlocker = 'manual' | 'offline' | 'noAgent'

export type UpdateExec =
    | {
          type: 'agentFramework'
          agentId: string
          framework: AgentFramework
          mode: FrameworkUpgradeMode
          targetVersion: string
      }
    | { type: 'daemonCli'; hostId: string }
    | { type: 'sandboxCli'; sandboxId: string }
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
    targetKey: string
    targetLabel: string
    installedVersion: string | null
    latestVersion: string | null
    severity: UpdateSeverity
    blockedReason: string | null
    blocker: UpdateBlocker | null
    exec: UpdateExec
}

export interface UpdateCenterInputs {
    daemonHosts: DaemonHostSummary[]
    sandboxes: SandboxSummary[]
    runtimes: AgentRuntimeSummary[]
    frameworkCatalog: FrameworkVersionCatalogEntry[]
    skillGroups: AgentSkillsGroup[]
}

export const emptyUpdateCenterInputs: UpdateCenterInputs = {
    daemonHosts: [],
    sandboxes: [],
    runtimes: [],
    frameworkCatalog: [],
    skillGroups: []
}

// A skill's revision is a git commit SHA; the whole thing is unreadable in a
// table cell and only the leading characters carry information.
const shortRevision = (revision: string): string => revision.slice(0, 7)

const kindOrder: Record<UpdateKind, number> = {
    cli: 0,
    framework: 1,
    cliUsage: 2,
    skill: 3
}

const compareRows = (a: UpdateRow, b: UpdateRow): number => {
    if (a.severity !== b.severity) return a.severity === 'required' ? -1 : 1
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind]
    const byTarget = a.targetLabel.localeCompare(b.targetLabel)
    if (byTarget !== 0) return byTarget
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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
            targetKey: `daemon:${host.id}`,
            targetLabel: host.name,
            installedVersion: host.cliVersion,
            latestVersion: host.latestCliVersion,
            severity: host.needsUpgrade ? 'required' : 'recommended',
            blockedReason: null,
            blocker,
            exec:
                blocker === null
                    ? { type: 'daemonCli', hostId: host.id }
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
            targetKey: `sandbox:${sandbox.id}`,
            targetLabel: sandbox.name,
            installedVersion: sandbox.cliVersion,
            latestVersion: sandbox.latestCliVersion,
            severity: 'recommended',
            blockedReason: null,
            blocker: null,
            exec: { type: 'sandboxCli', sandboxId: sandbox.id }
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
    runtime: AgentRuntimeSummary,
    sandboxNames: ReadonlyMap<string, string>
): { key: string; label: string } => {
    if (runtime.kind === 'daemon' && runtime.daemonId)
        return {
            key: `daemon:${runtime.daemonId}`,
            label: runtime.daemonName ?? runtime.name
        }
    if (runtime.kind === 'k8s' && runtime.clusterId)
        return {
            key: `k8s:${runtime.clusterId}`,
            label: runtime.clusterName ?? runtime.name
        }
    if (runtime.hostId)
        return {
            key: `sandbox:${runtime.hostId}`,
            label:
                sandboxNames.get(runtime.hostId) ??
                runtime.spriteName ??
                runtime.name
        }
    return { key: `runtime:${runtime.id}`, label: runtime.name }
}

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
    const sandboxNames = new Map(
        inputs.sandboxes.map((sandbox) => [sandbox.id, sandbox.name])
    )
    const rows: UpdateRow[] = []
    for (const runtime of inputs.runtimes) {
        if (!isVersionedFramework(runtime.framework)) continue
        const entry = catalog.get(runtime.framework)
        if (!entry?.latest) continue
        if (!frameworkUpgradeAvailable(runtime.frameworkVersion, entry.latest))
            continue

        const mode = frameworkUpgradeMode(runtime.framework)
        const target = runtimeTarget(runtime, sandboxNames)
        const remote =
            runtime.kind === 'sprites' && mode !== null && runtime.primaryAgentId
        const blocker: UpdateBlocker | null = remote
            ? null
            : runtime.kind === 'sprites'
              ? 'noAgent'
              : 'manual'
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
            severity: blocked ? 'required' : 'recommended',
            blockedReason: blocked?.reason ?? null,
            blocker,
            exec:
                remote && mode
                    ? {
                          type: 'agentFramework',
                          agentId: runtime.primaryAgentId as string,
                          framework: runtime.framework,
                          mode,
                          targetVersion: entry.latest
                      }
                    : {
                          type: 'none',
                          // A daemon runtime runs on the user's own machine, so
                          // the only honest affordance is the command to run
                          // there; anything else needs the runtime page.
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

const skillRows = (inputs: UpdateCenterInputs): UpdateRow[] => {
    const rows: UpdateRow[] = []
    for (const group of inputs.skillGroups)
        for (const skill of group.skills) {
            if (skill.readonly) continue
            if (skill.materializeStatus === 'installing') continue
            if (!skill.installedRevision || !skill.latestRevision) continue
            if (skill.installedRevision === skill.latestRevision) continue
            const kind: UpdateKind =
                skill.skillId === MANYFOLD_CLI_USAGE_SKILL_ID
                    ? 'cliUsage'
                    : 'skill'
            rows.push({
                id: `${kind}:${skill.agentId}:${skill.skillId}`,
                kind,
                subjectLabel: skill.name,
                framework: null,
                targetKind: 'agent',
                targetKey: `agent:${skill.agentId}`,
                targetLabel: group.agent.name,
                installedVersion:
                    skill.installedVersion ??
                    shortRevision(skill.installedRevision),
                latestVersion: shortRevision(skill.latestRevision),
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
        ...frameworkRows(inputs, frameworkLabel),
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

export type UpdateGroupBy = 'kind' | 'target' | 'status' | 'none'

export const updateGroupDims: readonly UpdateGroupBy[] = [
    'kind',
    'target',
    'status',
    'none'
]

export interface UpdateGroup {
    key: string
    label: string
    rows: UpdateRow[]
}

const statusOrder: UpdateStatus[] = ['required', 'ready', 'manual', 'offline']

// Groups follow the sort order already applied to the rows, except for status,
// which has a severity order of its own that first appearance would not honour.
export const groupUpdateRows = (
    rows: UpdateRow[],
    groupBy: UpdateGroupBy,
    labels: {
        kind: (kind: UpdateKind) => string
        status: (status: UpdateStatus) => string
        all: string
    }
): UpdateGroup[] => {
    if (groupBy === 'none')
        return rows.length === 0
            ? []
            : [{ key: 'all', label: labels.all, rows }]

    const order: string[] = []
    const byKey = new Map<string, UpdateGroup>()
    for (const row of rows) {
        const key =
            groupBy === 'kind'
                ? `kind:${row.kind}`
                : groupBy === 'target'
                  ? `target:${row.targetKey}`
                  : `status:${displayStatus(row)}`
        const label =
            groupBy === 'kind'
                ? labels.kind(row.kind)
                : groupBy === 'target'
                  ? row.targetLabel
                  : labels.status(displayStatus(row))
        let group = byKey.get(key)
        if (!group) {
            group = { key, label, rows: [] }
            byKey.set(key, group)
            order.push(key)
        }
        group.rows.push(row)
    }
    const keys =
        groupBy === 'status'
            ? statusOrder
                  .map((status) => `status:${status}`)
                  .filter((key) => byKey.has(key))
            : order
    return keys.map((key) => byKey.get(key) as UpdateGroup)
}

const kindParams: Record<UpdateKind, string> = {
    cli: 'cli',
    framework: 'framework',
    cliUsage: 'cli-usage',
    skill: 'skill'
}

export const kindParamOf = (kind: UpdateKind): string => kindParams[kind]

// The one spelling of the link every existing update reminder now points at.
export const updatesPath = (kind?: UpdateKind): string =>
    kind ? `/updates?kind=${kindParamOf(kind)}` : '/updates'

export const parseKindParam = (value: string | null): UpdateKind | null => {
    for (const [kind, param] of Object.entries(kindParams))
        if (param === value) return kind as UpdateKind
    return null
}

export const filterRowsByKind = (
    rows: UpdateRow[],
    kind: UpdateKind | null
): UpdateRow[] => (kind === null ? rows : rows.filter((r) => r.kind === kind))

export type BatchStep =
    // One call covers many agents, so selecting the same skill on twelve agents
    // is twelve rows but one request.
    | { type: 'skillBatch'; skillId: string; agentIds: string[]; rowIds: string[] }
    | {
          type: 'framework'
          rowId: string
          agentId: string
          framework: AgentFramework
          mode: FrameworkUpgradeMode
          targetVersion: string
      }
    | { type: 'daemonCli'; rowId: string; hostId: string }
    | { type: 'sandboxCli'; rowId: string; sandboxId: string }

export const SKILL_INSTALL_BATCH_LIMIT = 50

const stepOrder = (step: BatchStep): number => {
    switch (step.type) {
        case 'skillBatch':
            return 0
        case 'sandboxCli':
            return 1
        case 'daemonCli':
            return 2
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
export const planBatch = (rows: UpdateRow[]): BatchStep[] => {
    const steps: BatchStep[] = []
    const skillOrder: string[] = []
    const bySkill = new Map<string, { agentIds: string[]; rowIds: string[] }>()

    for (const row of rows) {
        if (row.blocker !== null) continue
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
                    hostId: row.exec.hostId
                })
                break
            case 'sandboxCli':
                steps.push({
                    type: 'sandboxCli',
                    rowId: row.id,
                    sandboxId: row.exec.sandboxId
                })
                break
            case 'agentFramework':
                steps.push({
                    type: 'framework',
                    rowId: row.id,
                    agentId: row.exec.agentId,
                    framework: row.exec.framework,
                    mode: row.exec.mode,
                    targetVersion: row.exec.targetVersion
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
