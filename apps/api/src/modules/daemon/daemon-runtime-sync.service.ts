import {
    DAEMON_FRAMEWORK_DETECT_INTERVAL_MS,
    DetectedFramework,
    createObjectId,
    parseProbedSemver
} from '@manyfold/shared'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    type Database,
    type RuntimeHostRow,
    type AgentRuntimeRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { nextFreeLabel } from '@/modules/agent-runtimes/runtime-label'

const STALE_FAILURE_REASON = 'framework not detected by daemon'

type RuntimePatch = Partial<
    Pick<
        AgentRuntimeRow,
        | 'status'
        | 'homeDir'
        | 'workspaceBaseDir'
        | 'mountPath'
        | 'frameworkVersion'
        | 'frameworkVersionCheckedAt'
        | 'capabilitiesJson'
        | 'lastSeenAt'
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
        // User-scoped on purpose: a machine re-registers under a fresh daemon
        // uuid (new host row) while its old rows keep their names, so the
        // insert below must see EVERY name this user holds, not just the ones
        // under the current host row.
        const userRuntimes = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.userId, host.userId))
        const existing = userRuntimes.filter((r) => r.daemonId === host.id)
        const taken = new Set(userRuntimes.map((r) => r.name))

        const detectedFw = new Set<string>(
            detectedFrameworks.map((d) => d.framework)
        )
        const now = new Date()
        // Per-runtime freshness follows the daemon's real probe cadence, not
        // the heartbeat's: host presence stays 15s-fresh on runtime_hosts, and
        // these columns are only advanced once the reported inventory could
        // possibly have been re-probed.
        const freshnessCutoff = new Date(
            now.getTime() - DAEMON_FRAMEWORK_DETECT_INTERVAL_MS
        )

        const result: AgentRuntimeRow[] = []
        const matchedIds: string[] = []
        const grouped = new Map<
            string,
            { patch: RuntimePatch; ids: string[] }
        >()
        for (const det of detectedFrameworks) {
            const found = existing.find((r) => r.framework === det.framework)
            const mountPath = daemonMountPathFor(det.framework, host)
            // The daemon reports the raw `<bin> --version` output (e.g.
            // "2.1.177 (Claude Code)"); parse it to a clean semver for the
            // frameworkVersion column the UI reads. Leave the column untouched
            // when unparseable so a transient probe miss doesn't wipe a known
            // version.
            //
            // parseProbedSemver, not parseProbedVersion: this is one of three
            // writers of agent_runtimes.framework_version, and the sprite ones
            // keep the prerelease suffix. Truncating here would make the same
            // installed build read as `1.15.1` on a daemon and `1.15.1-rc.1` on
            // a sprite, which every precedence comparison downstream would then
            // disagree about.
            const frameworkVersion = det.version
                ? parseProbedSemver(det.version)
                : null
            if (found) {
                matchedIds.push(found.id)
                const patch = this.diff({
                    found,
                    host,
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
            } else {
                const name = nextFreeLabel(
                    `${host.name}-${det.framework}`,
                    taken
                )
                taken.add(name)
                const [inserted] = await this.db
                    .insert(agentRuntimes)
                    .values({
                        id: createObjectId('agentRuntime'),
                        userId: host.userId,
                        name,
                        framework: det.framework,
                        kind: 'daemon',
                        status: 'ready',
                        daemonId: host.id,
                        homeDir: host.homeDir,
                        workspaceBaseDir: host.workspaceBaseDir,
                        ...(mountPath ? { mountPath } : {}),
                        ...(frameworkVersion
                            ? { frameworkVersion, frameworkVersionCheckedAt: now }
                            : {}),
                        capabilitiesJson: { detectedVersion: det.version },
                        lastSeenAt: now,
                        startedAt: now
                    })
                    .returning()
                result.push(inserted)
            }
        }

        for (const { patch, ids } of grouped.values())
            await this.db
                .update(agentRuntimes)
                .set(patch)
                .where(inArray(agentRuntimes.id, ids))

        // One set-based recovery instead of one statement per runtime. Kept
        // unconditional: agents can be stopped by paths that never touch the
        // runtime row, so the runtime diff above is not evidence that no agent
        // needs reviving.
        if (matchedIds.length > 0)
            await this.db
                .update(agents)
                .set({
                    status: 'running',
                    failureReason: null,
                    updatedAt: now
                })
                .where(
                    and(
                        inArray(agents.runtimeId, matchedIds),
                        eq(agents.status, 'stopped')
                    )
                )

        const stale = existing.filter((r) => !detectedFw.has(r.framework))
        if (stale.length > 0) {
            const transitioning = stale
                .filter((s) => s.status !== 'stopped')
                .map((s) => s.id)
            if (transitioning.length > 0)
                await this.db
                    .update(agentRuntimes)
                    .set({ status: 'stopped', updatedAt: now })
                    .where(inArray(agentRuntimes.id, transitioning))
            // Agents keep the wider id set as a safety net (a runtime can be
            // stopped while an agent under it is later revived elsewhere), but
            // the predicate stops it rewriting rows that already say this.
            await this.db
                .update(agents)
                .set({
                    status: 'stopped',
                    failureReason: STALE_FAILURE_REASON,
                    updatedAt: now
                })
                .where(
                    and(
                        inArray(
                            agents.runtimeId,
                            stale.map((s) => s.id)
                        ),
                        or(
                            ne(agents.status, 'stopped'),
                            isNull(agents.failureReason),
                            ne(agents.failureReason, STALE_FAILURE_REASON)
                        )
                    )
                )
        }

        return result
    }

    private diff(args: {
        found: AgentRuntimeRow
        host: RuntimeHostRow
        det: DetectedFramework
        mountPath: string | undefined
        frameworkVersion: string | null
        now: Date
        freshnessCutoff: Date
    }): RuntimePatch {
        const {
            found,
            host,
            det,
            mountPath,
            frameworkVersion,
            now,
            freshnessCutoff
        } = args
        const patch: RuntimePatch = {}
        if (found.status !== 'ready') patch.status = 'ready'
        if (found.homeDir !== host.homeDir) patch.homeDir = host.homeDir
        if (found.workspaceBaseDir !== host.workspaceBaseDir)
            patch.workspaceBaseDir = host.workspaceBaseDir
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
        if (isStale(found.lastSeenAt, freshnessCutoff)) patch.lastSeenAt = now
        if (
            frameworkVersion &&
            patch.frameworkVersionCheckedAt === undefined &&
            isStale(found.frameworkVersionCheckedAt, freshnessCutoff)
        )
            patch.frameworkVersionCheckedAt = now
        return patch
    }

    async markRuntimesStopped(daemonId: string): Promise<void> {
        const runtimes = await this.db
            .select({ id: agentRuntimes.id })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.daemonId, daemonId))
        const runtimeIds = runtimes.map((r) => r.id)
        await this.db
            .update(agentRuntimes)
            .set({ status: 'stopped', updatedAt: new Date() })
            .where(eq(agentRuntimes.daemonId, daemonId))
        if (runtimeIds.length > 0)
            await this.db
                .update(agents)
                .set({
                    status: 'stopped',
                    failureReason: 'daemon stopped',
                    updatedAt: new Date()
                })
                .where(inArray(agents.runtimeId, runtimeIds))
    }
}
