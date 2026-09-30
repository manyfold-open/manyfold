import { isVersionedFramework, parseProbedSemver } from '@manyfold/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    hostDaemons,
    type AgentRuntimeRow,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { FrameworkExecResolver } from '@/modules/agents/adapters/framework-exec'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import { recordProbedEntries } from '@/modules/daemon/probed-inventory'
import { RuntimeContextService } from '@/modules/hosts/runtime-context.service'
import { hostsFrameworkCli, runOnRuntimeHost } from './runtime-host-shell'

const PROBE_TIMEOUT_MS = 30_000

@Injectable()
export class FrameworkVersionProbeService {
    private readonly log = new Logger(FrameworkVersionProbeService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimeContext: RuntimeContextService,
        private readonly execResolver: FrameworkExecResolver
    ) {}

    // The installed version of a runtime's framework, probed and persisted.
    // Hosted machines only, through their daemon (ADR-0037). No-op for
    // non-versioned frameworks or other placements. A probe that cannot run
    // leaves the stored version untouched (never clobbers a known-good value
    // with null).
    async probeAndPersist(
        runtime: Pick<AgentRuntimeRow, 'id' | 'framework'>
    ): Promise<string | null> {
        if (!isVersionedFramework(runtime.framework)) return null
        const ctx = await this.runtimeContext.forRuntime(runtime.id)
        if (!ctx || !hostsFrameworkCli(ctx.placement)) return null

        const descriptor = frameworkVersionDescriptor(runtime.framework)
        let parsed: string | null = null
        try {
            const exec = await this.execResolver.forRuntime(ctx.runtime, this.log)
            const result = await runOnRuntimeHost(
                exec,
                descriptor.probeShell,
                PROBE_TIMEOUT_MS
            )
            parsed = parseProbedSemver(`${result.stdout}\n${result.stderr}`)
        } catch (err) {
            this.log.warn(
                `framework-version probe failed for runtime ${runtime.id}: ${(err as Error).message}`
            )
            return null
        }

        const now = new Date()
        await this.db
            .update(agentRuntimes)
            .set({
                ...(parsed ? { frameworkVersion: parsed } : {}),
                frameworkVersionCheckedAt: now,
                updatedAt: now
            })
            .where(eq(agentRuntimes.id, ctx.runtime.id))
        if (parsed && ctx.runtime.hostId)
            await this.recordOnHost(
                ctx.runtime.hostId,
                runtime.framework,
                parsed,
                now
            )
        return parsed
    }

    // The same version in the host's inventory, stamped, so the daemon's
    // cached report cannot write the one from before an upgrade back over it
    // (probed-inventory). A framework the daemon has not reported waits for
    // its next detection.
    private async recordOnHost(
        hostId: string,
        framework: string,
        version: string,
        now: Date
    ): Promise<void> {
        const [row] = await this.db
            .select({ detectedFrameworks: hostDaemons.detectedFrameworks })
            .from(hostDaemons)
            .where(eq(hostDaemons.hostId, hostId))
            .limit(1)
        const reported = row?.detectedFrameworks.find(
            (entry) => entry.framework === framework
        )
        if (!row || !reported) return
        await this.db
            .update(hostDaemons)
            .set({
                detectedFrameworks: recordProbedEntries(
                    row.detectedFrameworks,
                    [{ ...reported, version }],
                    now
                ),
                updatedAt: now
            })
            .where(eq(hostDaemons.hostId, hostId))
    }
}
