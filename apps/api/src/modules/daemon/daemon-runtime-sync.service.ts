import {
    DAEMON_FRAMEWORK_DETECT_INTERVAL_MS,
    DetectedFramework,
    createObjectId,
    parseProbedSemver
} from '@manyfold/shared'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    type Database,
    type RuntimeHostRow,
    type AgentRuntimeRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { nextFreeLabel } from '@/modules/agent-runtimes/runtime-label'

export const FRAMEWORK_NOT_DETECTED_REASON = 'framework not detected'

type RuntimePatch = Partial<
    Pick<
        AgentRuntimeRow,
        | 'status'
        | 'failureReason'
        | 'mountPath'
        | 'frameworkVersion'
        | 'frameworkVersionCheckedAt'
        | 'capabilitiesJson'
        | 'updatedAt'
    >
>

const daemonMountPathFor = (
    framework: DetectedFramework['framework'],
    host: RuntimeHostRow
): string | undefined => {
    if (!host.homeDir) return undefined
    const base = host.homeDir.replace(/\/+$/, '') || host.homeDir
    switch (framework) {
        case 'openclaw':
            return `${base}/.openclaw`
        case 'hermes':
            return `${base}/.hermes`
        case 'claude-code':
        case 'codex':
        case 'gemini-cli':
        case 'pi':
        case 'antigravity-cli':
            // Hosts running an older CLI registered `~/.nca/workspaces`;
            // trust what the daemon reported over the current default.
            return host.workspaceBaseDir ?? `${base}/.manyfold/workspaces`
    }
}

// The stored payload is always written as exactly `{ detectedVersion }`, so a
// same-shape/same-value object means the column would be rewritten with what it
// already holds.
const sameDetectionPayload = (
    stored: Record<string, unknown> | null,
    version: string | null
): boolean => {
    const keys = Object.keys(stored ?? {})
    return (
        keys.length === 1 &&
        keys[0] === 'detectedVersion' &&
        stored?.detectedVersion === version
    )
}

const isStale = (at: Date | null, cutoff: Date): boolean =>
    at === null || at.getTime() < cutoff.getTime()

// Stable key for "these rows want the identical SET clause", so N runtimes that
// change the same way cost one statement rather than N.
const patchKey = (patch: RuntimePatch): string =>
    JSON.stringify(patch, (_k, v: unknown) =>
        v instanceof Date ? v.toISOString() : v
    )

// A local host's runtimes are its daemon's software inventory (ADR-0036 R3):
// one runtime per detected framework, upserted on (host_id, framework) so a
// restart updates rows instead of adding them, and a framework that vanished
// from the inventory reads `failed` — the row stays for the agents on it.
// A hosted host's inventory only lives on host_daemons and creates nothing.
@Injectable()
export class DaemonRuntimeSyncService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    // Driven by BOTH `daemon register` and the 15s heartbeat. The heartbeat is
    // the hot path and its steady state is "nothing changed", so every write
    // here is conditional on a real value difference and grouped into set-based
    // statements: an unchanged host costs zero runtime UPDATEs no matter how
    // many frameworks it reports (#629).
    async syncForDaemon(args: {
        host: RuntimeHostRow
        detectedFrameworks: DetectedFramework[]
    }): Promise<AgentRuntimeRow[]> {
        const { host, detectedFrameworks } = args
        if (host.kind !== 'local') return []
        const existing = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.hostId, host.id))

        const detectedFw = new Set<string>(
            detectedFrameworks.map((d) => d.framework)
        )
        const now = new Date()
        // Per-runtime freshness follows the daemon's real probe cadence, not
        // the heartbeat's: these columns are only advanced once the reported
        // inventory could possibly have been re-probed.
        const freshnessCutoff = new Date(
            now.getTime() - DAEMON_FRAMEWORK_DETECT_INTERVAL_MS
        )

        const result: AgentRuntimeRow[] = []
        const grouped = new Map<
            string,
            { patch: RuntimePatch; ids: string[] }
        >()
        // The user's runtime names, read only when a row has to be made:
        // labels are `<host>-<framework>` and must not repeat what the user
        // already has, but the steady state makes nothing.
        let taken: Set<string> | null = null
        for (const det of detectedFrameworks) {
            const found = existing.find((r) => r.framework === det.framework)
            const mountPath = daemonMountPathFor(det.framework, host)
            // The daemon reports the raw `<bin> --version` output (e.g.
            // "2.1.177 (Claude Code)"); parse it to a clean semver for the
            // frameworkVersion column the UI reads. Leave the column untouched
            // when unparseable so a transient probe miss doesn't wipe a known
            // version.
            //
            // parseProbedSemver, not parseProbedVersion: the hosted install
            // path keeps the prerelease suffix, and the same build must not
            // read as `1.15.1` here and `1.15.1-rc.1` there.
            const frameworkVersion = det.version
                ? parseProbedSemver(det.version)
                : null
            if (found) {
                const patch = this.diff({
                    found,
                    det,
                    mountPath,
                    frameworkVersion,
                    now,
                    freshnessCutoff
                })
                if (Object.keys(patch).length > 0) {
                    const key = patchKey(patch)
                    const group = grouped.get(key)
                    if (group) group.ids.push(found.id)
                    else grouped.set(key, { patch, ids: [found.id] })
                }
                result.push({ ...found, ...patch })
                continue
            }
            if (!taken) {
                const rows = await this.db
                    .select({ name: agentRuntimes.name })
                    .from(agentRuntimes)
                    .where(eq(agentRuntimes.userId, host.userId))
                taken = new Set(rows.map((r) => r.name))
            }
            const name = nextFreeLabel(`${host.name}-${det.framework}`, taken)
            taken.add(name)
            const versionColumns = frameworkVersion
                ? { frameworkVersion, frameworkVersionCheckedAt: now }
                : {}
            // Two registers of the same machine racing each other both land
            // here for a framework neither has a row for; the partial unique
            // index makes the second one an update of the first.
            const [row] = await this.db
                .insert(agentRuntimes)
                .values({
                    id: createObjectId('agentRuntime'),
                    userId: host.userId,
                    name,
                    framework: det.framework,
                    hostId: host.id,
                    status: 'ready',
                    failureReason: null,
                    currentPhase: null,
                    ...(mountPath ? { mountPath } : {}),
                    ...versionColumns,
                    capabilitiesJson: { detectedVersion: det.version },
                    lastBootstrappedAt: now
                })
                .onConflictDoUpdate({
                    target: [agentRuntimes.hostId, agentRuntimes.framework],
                    targetWhere: sql`${agentRuntimes.hostId} is not null`,
                    set: {
                        status: 'ready',
                        failureReason: null,
                        ...(mountPath ? { mountPath } : {}),
                        ...versionColumns,
                        capabilitiesJson: { detectedVersion: det.version },
                        updatedAt: now
                    }
                })
                .returning()
            result.push(row)
        }

        for (const { patch, ids } of grouped.values())
            await this.db
                .update(agentRuntimes)
                .set(patch)
                .where(inArray(agentRuntimes.id, ids))

        // Frameworks that left the inventory: their runtimes read failed
        // (the row keeps its slot and the agents on it), and the set-based
        // predicate stops it rewriting rows that already say this.
        await this.db
            .update(agentRuntimes)
            .set({
                status: 'failed',
                failureReason: FRAMEWORK_NOT_DETECTED_REASON,
                updatedAt: now
            })
            .where(
                and(
                    eq(agentRuntimes.hostId, host.id),
                    detectedFw.size > 0
                        ? notInArray(agentRuntimes.framework, [...detectedFw])
                        : undefined,
                    ne(agentRuntimes.status, 'failed')
                )
            )

        return result
    }

    private diff(args: {
        found: AgentRuntimeRow
        det: DetectedFramework
        mountPath: string | undefined
        frameworkVersion: string | null
        now: Date
        freshnessCutoff: Date
    }): RuntimePatch {
        const { found, det, mountPath, frameworkVersion, now, freshnessCutoff } =
            args
        const patch: RuntimePatch = {}
        if (found.status !== 'ready') {
            patch.status = 'ready'
            patch.failureReason = null
        }
        if (mountPath && found.mountPath !== mountPath)
            patch.mountPath = mountPath
        if (frameworkVersion && found.frameworkVersion !== frameworkVersion) {
            patch.frameworkVersion = frameworkVersion
            // Only a value the daemon has not reported before proves a fresh
            // probe happened; a replayed cache claims nothing.
            patch.frameworkVersionCheckedAt = now
        }
        if (!sameDetectionPayload(found.capabilitiesJson, det.version))
            patch.capabilitiesJson = { detectedVersion: det.version }
        // Content changes are an audit event; the freshness touch below is not,
        // so it deliberately leaves updatedAt alone.
        if (Object.keys(patch).length > 0) patch.updatedAt = now
        if (
            frameworkVersion &&
            patch.frameworkVersionCheckedAt === undefined &&
            isStale(found.frameworkVersionCheckedAt, freshnessCutoff)
        )
            patch.frameworkVersionCheckedAt = now
        return patch
    }
}
