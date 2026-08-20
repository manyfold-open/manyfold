import { createHash, timingSafeEqual } from 'node:crypto'
import {
    ConflictException,
    Inject,
    Injectable,
    Optional,
    UnauthorizedException
} from '@nestjs/common'
import type { Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { AppEventsService } from '@/common/events/app-events.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { DaemonRateLimitService } from '@/modules/daemon/daemon-rate-limit.service'
import { loadRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'
import type { CreateRuntimeReportDto } from './dto/create-runtime-report.dto'

const IP_RATE_LIMIT = 60
const RUNTIME_RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000

@Injectable()
export class RuntimeReportsService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly telemetry: TelemetryService,
        private readonly runtimes: AgentRuntimesService,
        private readonly reconcile: AgentReconcileService,
        private readonly rateLimit: DaemonRateLimitService,
        @Optional()
        private readonly appEvents?: AppEventsService
    ) {}

    async ingest(
        ip: string,
        bearer: string | null,
        dto: CreateRuntimeReportDto
    ): Promise<void> {
        this.rateLimit.sweep()
        // Coarse pre-auth circuit breaker only: the forwarded client IP the
        // controller derives is spoofable for key rotation, so real flood
        // isolation comes from the post-auth per-runtime window below. The
        // limiter is in-memory per API instance (single-instance assumption
        // documented on DaemonRateLimitService).
        this.rateLimit.consume({
            key: `ip:${ip}`,
            limit: IP_RATE_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        if (!bearer) throw new UnauthorizedException('unauthorized')
        const runtime = await this.runtimes.findById(dto.runtimeId)
        // Uniform 401 for unknown/out-of-scope runtimes and bad tokens: no
        // existence oracle, and exec-kind/k8s/daemon runtimes stay untouched.
        if (
            !runtime ||
            runtime.kind !== 'sprites' ||
            !isServiceFramework(runtime.framework)
        ) {
            throw new UnauthorizedException('unauthorized')
        }
        const stored = await loadRuntimeReportToken(
            this.db,
            this.crypto,
            runtime.id
        )
        if (!stored || !tokensMatch(bearer, stored))
            throw new UnauthorizedException('unauthorized')

        // Per-runtime window, consumed only AFTER token verification: sprites
        // behind shared egress/fly-proxy can collapse onto one derived IP, so
        // the IP bucket alone would let a single flooder starve every other
        // runtime's boot reports; keying post-auth means unauthenticated
        // traffic cannot burn a victim runtime's budget.
        this.rateLimit.consume({
            key: `runtime:${runtime.id}`,
            limit: RUNTIME_RATE_LIMIT,
            windowMs: RATE_WINDOW_MS
        })

        // DELIBERATE DIVERGENCE from the daemon liveness model: daemon
        // heartbeat-loss -> stopped is correct because the platform cannot
        // wake a daemon (daemon-presence 45s sweep); sprite report silence
        // derives only asleep/stale at read time because the platform CAN
        // wake sprites. That is why no report-driven path may ever write
        // 'stopped': the closed event map below produces only
        // 'starting'/'ready', and stopped runtimes are rejected BEFORE any
        // write or touch (a touch would let reconcileRuntime's stopped branch
        // mark agents stopped). lastSeenAt (daemon presence) and
        // service_status_at (sprite service assertion) stay separately owned.
        if (
            runtime.status === 'stopped' ||
            runtime.serviceStatus === 'stopped'
        ) {
            throw new ConflictException('runtime_stopped')
        }
        const fence = serviceReportGeneration(runtime.capabilitiesJson)
        if (!fence || fence !== dto.generation) {
            this.telemetry.event('runtime_report_stale', {
                runtimeId: runtime.id,
                framework: runtime.framework,
                event: dto.event
            })
            throw new ConflictException('stale_generation')
        }
        await this.runtimes.applyServiceReportPatch(runtime.id, {
            serviceStatus: dto.event === 'ready' ? 'ready' : 'starting',
            serviceStatusAt: new Date()
        })
        this.telemetry.event('runtime_report_accepted', {
            runtimeId: runtime.id,
            framework: runtime.framework,
            event: dto.event
        })
        if (dto.event === 'ready') {
            this.reconcile.touchRuntime(runtime, { verifiedByReport: true })
            this.appEvents?.emit('runtime.report.ready', {
                runtimeId: runtime.id,
                framework: runtime.framework
            })
        }
    }
}

const isServiceFramework = (framework: string): boolean =>
    framework === 'hermes' ||
    framework === 'openclaw' ||
    framework === 'narranexus'

const serviceReportGeneration = (
    capabilities: Record<string, unknown> | null
): string | null => {
    const raw = capabilities?.serviceReport
    if (!raw || typeof raw !== 'object') return null
    const generation = (raw as { generation?: unknown }).generation
    return typeof generation === 'string' && generation.length > 0
        ? generation
        : null
}

const tokensMatch = (presented: string, stored: string): boolean =>
    timingSafeEqual(
        createHash('sha256').update(presented).digest(),
        createHash('sha256').update(stored).digest()
    )
