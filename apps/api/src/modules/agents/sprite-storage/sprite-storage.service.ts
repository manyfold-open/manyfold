import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { and, eq, ne } from 'drizzle-orm'
import {
    agents,
    runtimeHosts,
    type Agent,
    type AgentStorageBreakdown,
    type Database,
    type RuntimeHostRow,
    type SandboxStorageBreakdown
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSprite,
    SpritesError,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { SpriteExecHealthService } from '@/modules/agents/sprite-exec-health/sprite-exec-health.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    redactDiagnosticText,
    shellQuote
} from '@/modules/agents/agent-diagnostics.service'

const MIN_INTERVAL_MS = 5 * 60 * 1000
const CMD_TIMEOUT_MS = 8_000
const SECTION_SEP = '__NCA_STORAGE_SEP__'
// sprites.dev bills the whole persistent rootfs and gives the VM no separate
// volume, so the meter always reads `/`. Borrowing an agent's mountPath made
// an agent-less sandbox df a path nothing creates.
const DF_TARGET = '/'

export interface MeasureTarget {
    host: RuntimeHostRow
    hostAgents: Agent[]
    homes: { framework: string; homeDir: string }[]
}

@Injectable()
export class SpriteStorageService {
    private readonly log = new Logger(SpriteStorageService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly telemetry: TelemetryService,
        @Optional() private readonly execHealth?: SpriteExecHealthService
    ) {}

    async measureIfDue(agentId: string): Promise<void> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) return
        if (agent.runtime !== 'sprites') return
        if (!agent.hostId) return
        await this.measureHostIfDue(agent.hostId)
    }

    // Storage is measured (and metered) per sandbox VM: sprites.dev bills the
    // whole rootfs per sprite, so one df reading per host is the billable
    // figure. Per-agent workspace and per-framework home du readings ride along
    // as the drill-down.
    async measureHostIfDue(hostId: string): Promise<void> {
        const [host] = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, hostId))
            .limit(1)
        if (!host) return
        if (host.kind !== 'sandbox') return
        if (!host.accountId || !host.spriteName) return
        if (host.spriteStatus !== 'running') return

        if (host.storageMeasuredAt) {
            const sinceMs = Date.now() - host.storageMeasuredAt.getTime()
            if (sinceMs < MIN_INTERVAL_MS) return
        }

        // A VM already known to be refusing exec is not worth six 8s df/du
        // timeouts per request (#730 saw exactly that, from the prewarm and
        // message paths of three requests). Asked after the interval check, so
        // the common not-due call still costs one read.
        //
        // READ-ONLY on purpose: measurement never claims the fleet's one probe
        // lease and never clears a cooldown — spending the probe here would leave
        // the turn that follows with nothing to claim, and a df is not the
        // idempotent no-op that proves recovery. The interval bookkeeping is
        // untouched, so the next due window measures normally once the host is
        // back (#553 / #575 / #580 semantics unchanged).
        if (await this.execHealth?.isKnownUnavailable(host.id)) {
            this.log.debug('storage measurement skipped: exec endpoint unhealthy')
            return
        }

        try {
            const target = await this.targetFor(host)
            const breakdown = await this.measureNow(target)
            // 'stale' means neither df nor any du produced a reading. Persisting
            // it would publish a fabricated 0 into the storage meter and quota
            // check over whatever the host really holds, so it takes the same
            // path as a thrown measurement error and the previous reading stays.
            if (breakdown.measuredVia === 'stale')
                throw new Error(
                    `df/du produced no reading for host ${host.id}`
                )
            await this.persist(target, breakdown)
            this.telemetry.event('sprite_storage_measured', {
                hostId: host.id,
                userId: host.userId,
                vmUsedBytes: breakdown.vmUsedBytes,
                workspaceBytes: sumBytes(breakdown.workspaces),
                homeBytes: sumBytes(breakdown.homes),
                agentCount: target.hostAgents.length,
                measuredVia: breakdown.measuredVia
            })
        } catch (err) {
            this.telemetry.error(
                'sprite_storage_measure_failed',
                new Error('sprite storage measurement failed'),
                {
                    hostId: host.id,
                    userId: host.userId,
                    failureClass:
                        err instanceof SpritesError
                            ? `SpritesError:${err.code}`
                            : err instanceof Error && err.name
                              ? err.name
                              : typeof err
                }
            )
        }
    }

    private async targetFor(host: RuntimeHostRow): Promise<MeasureTarget> {
        const hostAgents = await this.db
            .select()
            .from(agents)
            .where(
                and(
                    eq(agents.hostId, host.id),
                    eq(agents.runtime, 'sprites'),
                    ne(agents.status, 'failed')
                )
            )
        const homes = new Map<string, string>()
        for (const agent of hostAgents) {
            const homeDir = frameworkHomeDir(agent.framework)
            if (homeDir && !homes.has(agent.framework))
                homes.set(agent.framework, homeDir)
        }
        return {
            host,
            hostAgents,
            homes: [...homes.entries()].map(([framework, homeDir]) => ({
                framework,
                homeDir
            }))
        }
    }

    private async measureNow(
        target: MeasureTarget
    ): Promise<SandboxStorageBreakdown> {
        const { host } = target
        const account = await this.accounts.getById(host.accountId as string)
        if (!account)
            throw new Error(
                `sprites account ${host.accountId} not found for host ${host.id}`
            )
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug,
            logger: spritesLoggerFor(this.log)
        })
        const script = buildMeasureScript(target)
        const result = await execSprite(
            client,
            host.spriteName as string,
            {
                cmd: ['bash', '-lc', script],
                stdin: '',
                timeoutMs: CMD_TIMEOUT_MS
            },
            spritesLoggerFor(this.log)
        )
        if (result.exitCode !== 0)
            throw new Error(
                `df/du failed: ${redactDiagnosticText(
                    result.stderr || result.stdout || `exit ${result.exitCode}`
                )}`
            )
        return parseMeasureOutput(target, result.stdout)
    }

    private async persist(
        target: MeasureTarget,
        breakdown: SandboxStorageBreakdown
    ): Promise<void> {
        const now = new Date()
        const hostBytes =
            breakdown.measuredVia === 'df'
                ? breakdown.vmUsedBytes
                : sumBytes(breakdown.workspaces) + sumBytes(breakdown.homes)
        await this.db
            .update(runtimeHosts)
            .set({
                storageBytes: hostBytes,
                storageMeasuredAt: now,
                storageBreakdown: breakdown,
                updatedAt: now
            })
            .where(eq(runtimeHosts.id, target.host.id))
        const workspaceByAgent = new Map(
            breakdown.workspaces.map((w) => [w.agentId, w.bytes])
        )
        const homeByFramework = new Map(
            breakdown.homes.map((h) => [h.framework, h.bytes])
        )
        for (const agent of target.hostAgents) {
            const workspaceBytes = workspaceByAgent.get(agent.id)
            // No entry means this agent's du produced nothing; leave its
            // previous reading alone rather than overwrite it with a 0.
            if (workspaceBytes === undefined) continue
            const homeBytes = homeByFramework.get(agent.framework) ?? 0
            const agentBreakdown: AgentStorageBreakdown = {
                workspaceBytes,
                homeBytes,
                totalBytes: workspaceBytes + homeBytes,
                measuredVia: breakdown.measuredVia
            }
            await this.db
                .update(agents)
                .set({
                    storageBytes: workspaceBytes,
                    storageMeasuredAt: now,
                    storageBreakdown: agentBreakdown,
                    updatedAt: now
                })
                .where(eq(agents.id, agent.id))
        }
    }
}

const frameworkHomeDir = (framework: Agent['framework']): string | null => {
    switch (framework) {
        case 'claude-code':
            return '~/.claude'
        case 'codex':
            return '~/.codex'
        case 'gemini-cli':
            return '~/.gemini'
        default:
            return null
    }
}

const workspacePathFor = (agent: Agent): string =>
    agent.workspacePath || agent.mountPath || '/workspace'

// Section order is the parse contract: df, then one du per agent workspace
// (hostAgents order), then one du per framework home (homes order).
//
// An empty section is the failure signal. Each section ends in awk, which exits
// 0 on empty input, so a failed df/du can never be detected from an exit status
// or coaxed into printing a fallback value — it just yields no line.
// parseMeasureOutput therefore treats a section with no number as unmeasured,
// never as a measured 0.
export const buildMeasureScript = (target: MeasureTarget): string => {
    const sections = [
        `df -B1 ${DF_TARGET} 2>/dev/null | tail -n1 | awk '{print $(NF-3)}'`
    ]
    for (const agent of target.hostAgents)
        sections.push(
            `du -sb ${shellQuote(workspacePathFor(agent))} 2>/dev/null | awk '{print $1}'`
        )
    for (const home of target.homes)
        sections.push(`du -sb ${home.homeDir} 2>/dev/null | awk '{print $1}'`)
    return [
        'set +e',
        ...sections.flatMap((cmd, i) =>
            i === 0 ? [cmd] : [`echo ${SECTION_SEP}`, cmd]
        )
    ].join('\n')
}

export const parseMeasureOutput = (
    target: Pick<MeasureTarget, 'hostAgents' | 'homes'>,
    stdout: string
): SandboxStorageBreakdown => {
    const parts = stdout.split(SECTION_SEP).map((s) => s.trim())
    const dfBytes = parseFirstNumber(parts[0])
    const workspaces = target.hostAgents.flatMap((agent, i) => {
        const bytes = parseFirstNumber(parts[1 + i])
        return bytes === null ? [] : [{ agentId: agent.id, bytes }]
    })
    const homes = target.homes.flatMap((home, i) => {
        const bytes = parseFirstNumber(
            parts[1 + target.hostAgents.length + i]
        )
        return bytes === null ? [] : [{ framework: home.framework, bytes }]
    })
    if (dfBytes !== null && dfBytes > 0)
        return { vmUsedBytes: dfBytes, homes, workspaces, measuredVia: 'df' }
    const duTotal = sumBytes(workspaces) + sumBytes(homes)
    if (duTotal > 0)
        return { vmUsedBytes: duTotal, homes, workspaces, measuredVia: 'du' }
    // Nothing readable came back. A rootfs never genuinely reports 0 used, so
    // this is a failed measurement, not an empty VM — the caller must not
    // persist it. vmUsedBytes stays 0 only to satisfy the type.
    return { vmUsedBytes: 0, homes, workspaces, measuredVia: 'stale' }
}

const sumBytes = (items: { bytes: number }[]): number =>
    items.reduce((total, item) => total + item.bytes, 0)

const parseFirstNumber = (value: string | undefined): number | null => {
    if (!value) return null
    const match = value.trim().match(/^(\d+)/m)
    if (!match) return null
    const n = Number(match[1])
    return Number.isFinite(n) ? n : null
}

const spritesLoggerFor = (log: Logger): SpritesLogger => ({
    debug: () => {},
    info: () => {},
    warn: (m) => log.warn(`[sprite-storage] ${m}`),
    error: (m) => log.error(`[sprite-storage] ${m}`)
})
