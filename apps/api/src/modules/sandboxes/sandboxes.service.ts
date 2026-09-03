import {
    auditAction,
    cliChannelOfVersion,
    isCliUpdateAvailable,
    isPlatformTaskName,
    isServiceFrameworkName,
    parseProbedSemver
} from '@manyfold/shared'
import type {
    CreateSandboxBody,
    DetectedFramework,
    MfCliChannel,
    SandboxServiceSummary,
    SandboxStopResponse,
    SandboxSummary,
    SandboxTaskSummary,
    SetSandboxTerminalBody,
    SetSandboxTerminalModelCredentialsBody
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import {
    auditLogs,
    type Database,
    type RuntimeHostRow,
    type SpritesAccount
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSprite,
    SpritesError
} from '@manyfold/sprites'
import type {
    ExecOptions,
    ExecResult,
    ServiceListResponse,
    ServiceObject,
    SpritesClient
} from '@manyfold/sprites'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import {
    AgentsService,
    SPRITES_AUTO_SLEEP_SEC
} from '@/modules/agents/agents.service'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { DRIZZLE } from '@/db/tokens'
import { SpriteStatusSyncService } from '@/modules/agents/sprite-status/sprite-status-sync.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import {
    DaemonCliVersionService,
    type LatestCliVersion
} from '@/modules/daemon/daemon-cli-version.service'
import { CliVersionCatalogService } from '@/modules/daemon/cli-version-catalog.service'
import { buildCliInstallScript } from '@/modules/agent-self/sprite-shell-env.service'

// The coding-agent CLIs every sprite image ships pre-installed. Probed as a unit
// so a bare sandbox can advertise what it can host before any runtime exists.
const SPRITE_CODING_FRAMEWORKS: DetectedFramework['framework'][] = [
    'claude-code',
    'codex',
    'gemini-cli'
]
const DETECT_TIMEOUT_MS = 30_000
const CLI_UPGRADE_TIMEOUT_MS = 180_000

@Injectable()
export class SandboxesService {
    private readonly log = new Logger(SandboxesService.name)

    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly spritesProvisioner: SpritesProvisioner,
        private readonly accounts: SpritesAccountsService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly cliCatalog: CliVersionCatalogService,
        private readonly spriteStatusSync: SpriteStatusSyncService,
        private readonly activeDuration: SandboxActiveDurationService,
        private readonly agents: AgentsService,
        private readonly keepAliveLease: SpriteKeepAliveLeaseService,
        @Inject(DRIZZLE) private readonly db: Database
    ) {}

    async list(
        userId: string,
        isAdmin = false
    ): Promise<SandboxSummary[]> {
        const rows = isAdmin
            ? await this.runtimes.listAllSandboxes()
            : await this.runtimes.listSandboxesForUser(userId)
        const latest = await this.cliVersion.getCachedLatest()
        const activeSeconds =
            await this.activeDuration.activeSecondsInPeriodByHost(
                rows.map((r) => ({ id: r.host.id, userId: r.host.userId }))
            )
        return rows.map((r) =>
            toSandboxSummary(
                r.host,
                r.accountSlug,
                r.agentsCount,
                latest,
                activeSeconds.get(r.host.id) ?? 0
            )
        )
    }

    async get(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const latest = await this.cliVersion.getCachedLatest()
        const activeSeconds =
            await this.activeDuration.activeSecondsInPeriodByHost([
                { id: r.host.id, userId: r.host.userId }
            ])
        return toSandboxSummary(
            r.host,
            r.accountSlug,
            r.agentsCount,
            latest,
            activeSeconds.get(r.host.id) ?? 0
        )
    }

    // Admin paths address sandboxes across all users. We resolve the real owner
    // once, then drive the existing user-scoped runtime mutations with that owner
    // id so their ownership checks pass without duplicating every query.
    private async resolveOwner(
        userId: string,
        hostId: string,
        isAdmin: boolean
    ): Promise<string> {
        if (!isAdmin) return userId
        const r = await this.runtimes.getSandboxById(hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        return r.host.userId
    }

    async create(
        userId: string,
        body: CreateSandboxBody
    ): Promise<SandboxSummary> {
        // Account pinning is admin-only and has no user-facing endpoint yet, so
        // the user path always auto-selects (isAdmin=false, matching the agents
        // controller). body.accountId is reserved for a future admin surface.
        const host = await this.spritesProvisioner.createStandaloneSandbox({
            userId,
            name: body.name,
            accountId: null,
            isAdmin: false
        })
        const full = await this.runtimes.getSandboxForUser(userId, host.id)
        const latest = await this.cliVersion.getCachedLatest()
        return full
            ? toSandboxSummary(
                  full.host,
                  full.accountSlug,
                  full.agentsCount,
                  latest,
                  0
              )
            : toSandboxSummary(host, null, 0, latest, 0)
    }

    async delete(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<void> {
        const owner = await this.resolveOwner(userId, hostId, isAdmin)
        await this.spritesProvisioner.deleteSandbox({ userId: owner, hostId })
    }

    async setTerminal(
        userId: string,
        hostId: string,
        body: SetSandboxTerminalBody,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const owner = await this.resolveOwner(userId, hostId, isAdmin)
        const ok = await this.runtimes.setSandboxTerminalEnabled(
            owner,
            hostId,
            body.enabled
        )
        if (!ok) throw new NotFoundException(`sandbox ${hostId} not found`)
        return this.get(owner, hostId)
    }

    async setTerminalModelCredentials(
        userId: string,
        hostId: string,
        body: SetSandboxTerminalModelCredentialsBody,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const owner = await this.resolveOwner(userId, hostId, isAdmin)
        const ok = await this.runtimes.setSandboxTerminalModelCredentials(
            owner,
            hostId,
            body.enabled
        )
        if (!ok) throw new NotFoundException(`sandbox ${hostId} not found`)
        return this.get(owner, hostId)
    }

    async rename(
        userId: string,
        hostId: string,
        name: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const owner = await this.resolveOwner(userId, hostId, isAdmin)
        const ok = await this.runtimes.setSandboxHostName(owner, hostId, name)
        if (!ok) throw new NotFoundException(`sandbox ${hostId} not found`)
        return this.get(owner, hostId)
    }

    // Probe the sprite for its pre-installed coding-agent CLIs and persist the
    // result on the host (runtime_hosts.detected_frameworks — same field daemons
    // use). A probe failure leaves the stored value untouched (never clobbers).
    async detectFrameworks(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const { host } = r
        const owner = host.userId
        if (host.spriteId && host.spriteName && host.accountId) {
            const probe = await this.probeSpriteFrameworks(
                host.accountId,
                host.spriteName
            )
            if (probe) {
                await this.runtimes.setHostDetectedFrameworks(
                    owner,
                    hostId,
                    probe.frameworks
                )
                await this.runtimes.applyDetectedVersionsToHostRuntimes(
                    hostId,
                    probe.frameworks
                )
                if (probe.cliVersion)
                    await this.runtimes.setSandboxCliVersion(
                        owner,
                        hostId,
                        probe.cliVersion
                    )
            }
        }
        return this.get(owner, hostId)
    }

    // On-demand refresh of the sandbox's sprites.dev lifecycle status, backing
    // the host detail "Refresh" button. The periodic sync lags (up to 30s while
    // warm/cold); this reads the sprite directly and persists it, so the
    // returned summary carries the fresh active/warm/cold state.
    async refreshStatus(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const { host } = r
        if (host.spriteId && host.spriteName && host.accountId)
            await this.spriteStatusSync
                .refreshSandboxHost(host)
                .catch((err: Error) => {
                    throw new ServiceUnavailableException(
                        `failed to refresh sandbox status: ${err.message}`
                    )
                })
        return this.get(host.userId, hostId)
    }

    // Upgrade the platform-managed mf CLI on the sprite to the latest version for
    // the deploy channel. Unlike daemons (which self-update + restart), a sprite
    // has no long-lived process — we exec the channel install script over
    // ~/.local/bin/mf and re-read the version. The fresh binary is picked up by
    // the next per-exec mf invocation, so nothing needs restarting.
    async upgradeCli(
        userId: string,
        hostId: string,
        targetVersion?: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const { host } = r
        const owner = host.userId
        if (!host.spriteId || !host.spriteName || !host.accountId)
            throw new BadRequestException('sandbox is not provisioned')
        const account = await this.accounts.getById(host.accountId)
        if (!account)
            throw new BadRequestException('sandbox account unavailable')
        // No target = the deploy channel's latest. A pinned target must be a
        // version we actually list, and its channel comes from the version
        // string (so a dev build installs from the dev CDN).
        let channel: MfCliChannel
        if (targetVersion) {
            if (!(await this.cliCatalog.isInstallableVersion(targetVersion)))
                throw new BadRequestException(
                    `unknown mf CLI version ${targetVersion}`
                )
            channel = cliChannelOfVersion(targetVersion)
        } else {
            channel = (await this.cliVersion.getCachedLatest()).channel
        }
        const shell = [
            buildCliInstallScript(channel, targetVersion),
            'echo "mf-upgraded=$("$HOME/.local/bin/mf" --version 2>/dev/null | head -1)"'
        ].join('\n')
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
        const result = await execSprite(client, host.spriteName, {
            cmd: ['bash', '-lc', shell],
            stdin: '',
            timeoutMs: CLI_UPGRADE_TIMEOUT_MS
        }).catch((err: Error) => {
            throw new ServiceUnavailableException(
                `mf CLI upgrade failed: ${err.message}`
            )
        })
        const mfLine = `${result.stdout}\n${result.stderr}`
            .split('\n')
            .find((l) => l.startsWith('mf-upgraded='))
        const installed = parseProbedSemver(
            mfLine ? mfLine.slice('mf-upgraded='.length) : ''
        )
        if (result.exitCode !== 0 || !installed)
            throw new ServiceUnavailableException(
                `mf CLI upgrade did not complete on ${host.spriteName}`
            )
        await this.runtimes.setSandboxCliVersion(owner, hostId, installed)
        return this.get(owner, hostId)
    }

    // The sprites.dev managed services registered on this sandbox's sprite. A
    // service registered by the agent (e.g. an http.server serving its
    // workspace) keeps the VM running outside keep-alive accounting — surfacing
    // them here lets the owner see and remove the ones holding the sprite awake.
    async listServices(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxServiceSummary[]> {
        const { spriteName, accountId } = await this.requireProvisionedSandbox(
            userId,
            hostId,
            isAdmin
        )
        const client = this.spritesClientFor(
            await this.requireAccount(accountId)
        )
        const services = await this.readServicesOnSprite(client, spriteName)
        return services.map(toServiceSummary)
    }

    private async readServicesOnSprite(
        client: SpritesClient,
        spriteName: string
    ): Promise<ServiceObject[]> {
        const raw = (await client
            .listServices(spriteName)
            .catch((err: Error) => {
                throw new ServiceUnavailableException(
                    `failed to list services on ${spriteName}: ${err.message}`
                )
            })) as unknown
        // The live sprites.dev API returns a bare array here; the typed
        // ServiceListResponse envelope is also accepted for forward-compat.
        return Array.isArray(raw)
            ? (raw as ServiceObject[])
            : ((raw as ServiceListResponse).services ?? [])
    }

    async deleteService(
        userId: string,
        hostId: string,
        name: string,
        isAdmin = false
    ): Promise<void> {
        // Manyfold's own framework services (hermes/openclaw/narranexus) are
        // platform infrastructure — never deletable from this surface.
        if (isServiceFrameworkName(name))
            throw new BadRequestException(
                `service '${name}' is managed by Manyfold and cannot be deleted`
            )
        const { spriteName, accountId } = await this.requireProvisionedSandbox(
            userId,
            hostId,
            isAdmin
        )
        const client = this.spritesClientFor(
            await this.requireAccount(accountId)
        )
        await client.deleteService(spriteName, name).catch((err: Error) => {
            // Already gone is success for an idempotent delete.
            if (err instanceof SpritesError && err.code === 'not_found') return
            throw new ServiceUnavailableException(
                `failed to delete service '${name}': ${err.message}`
            )
        })
    }

    // The sprite's activity tasks (/v1/tasks) — TTL leases that hold the VM in
    // the running state; the keep-alive toggle installs one of these. Tasks are
    // sprite-local (no control-plane REST) and reading them needs an exec into
    // the VM, which would wake an idle sprite. But an active task forces the
    // running state, so a non-running sprite has no tasks by definition — we
    // skip the exec and return empty, never waking a sleeping sandbox.
    async listTasks(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxTaskSummary[]> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const { host } = r
        if (
            host.spriteStatus !== 'running' ||
            !host.spriteName ||
            !host.accountId
        )
            return []
        const client = this.spritesClientFor(
            await this.requireAccount(host.accountId)
        )
        const raw = await this.readTasksOnSprite(client, host.spriteName)
        return raw
            .filter((t) => typeof t.name === 'string')
            .map((t) => ({
                name: t.name as string,
                startedAt:
                    typeof t.started_at === 'string' ? t.started_at : null,
                expiresAt:
                    typeof t.expires_at === 'string' ? t.expires_at : null,
                keepAlive: isPlatformTaskName(t.name as string)
            }))
    }

    private async readTasksOnSprite(
        client: SpritesClient,
        spriteName: string
    ): Promise<
        Array<{ name?: unknown; started_at?: unknown; expires_at?: unknown }>
    > {
        const result = await this.exec(client, spriteName, {
            cmd: ['sprite-env', 'curl', '-s', '/v1/tasks'],
            stdin: '',
            timeoutMs: 20_000,
            keepAliveMs: 5_000,
            livenessTimeoutMs: 12_000
        }).catch((err: Error) => {
            throw new ServiceUnavailableException(
                `failed to read tasks on ${spriteName}: ${err.message}`
            )
        })
        try {
            const body = JSON.parse(result.stdout.trim() || '{}') as {
                tasks?: Array<{
                    name?: unknown
                    started_at?: unknown
                    expires_at?: unknown
                }>
            }
            return body.tasks ?? []
        } catch {
            return []
        }
    }

    async deleteTask(
        userId: string,
        hostId: string,
        name: string,
        isAdmin = false
    ): Promise<void> {
        // Platform keep-alive leases are lifecycle-managed by the runtime
        // keep-alive toggle — never deletable from this surface (reconcile
        // would re-register them anyway).
        if (isPlatformTaskName(name))
            throw new BadRequestException(
                `task '${name}' is a Manyfold keep-alive lease — turn keep-alive off on the runtime instead`
            )
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const { host } = r
        // An active task forces the running state, so a non-running sprite has
        // no tasks to delete — and the exec would wake it.
        if (
            host.spriteStatus !== 'running' ||
            !host.spriteName ||
            !host.accountId
        )
            throw new ConflictException(
                `sandbox ${hostId} is not running — it has no active tasks to delete`
            )
        const client = this.spritesClientFor(
            await this.requireAccount(host.accountId)
        )
        const remaining = await this.deleteTaskOnSprite(
            client,
            host.spriteName,
            name
        )
        if (remaining.some((t) => t.name === name))
            throw new ConflictException(
                `task '${name}' is still registered — a process inside the sandbox re-registered it or the delete failed`
            )
    }

    // Sandbox-wide stop: removes every wake cause so the VM can suspend —
    // per-agent stop (sessions, keep-alive flag, framework services, platform
    // leases), then non-managed services stopped, then agent-registered
    // activity tasks deleted. Stopped agents wake again on their next message;
    // keep-alive stays off until re-enabled. Host-level terminal sessions are
    // not closed here and can still hold the VM awake until they end.
    async stop(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxStopResponse> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const { host } = r
        // A non-running sprite has nothing pinning it awake, and the task
        // sweep's exec would wake it — the one thing a stop must never do.
        if (
            host.spriteStatus !== 'running' ||
            !host.spriteName ||
            !host.accountId
        )
            return {
                status: 'noop',
                stoppedAgents: 0,
                stoppedServices: [],
                deletedTasks: [],
                estimatedReadyInSec: 0,
                warnings: []
            }
        const spriteName = host.spriteName
        const warnings: string[] = []
        let estimate = SPRITES_AUTO_SLEEP_SEC

        let stoppedAgents = 0
        const handledRuntimeIds = new Set<string>()
        const agentsOnHost = await this.runtimes.listAgentsByHost(hostId)
        for (const a of agentsOnHost) {
            try {
                const res = await this.agents.stopSprite(a.id, userId, isAdmin)
                if (res.status === 'pending') {
                    stoppedAgents++
                    handledRuntimeIds.add(a.runtimeId)
                }
                estimate = Math.max(estimate, res.estimatedReadyInSec)
                if (
                    res.keepAliveRelease?.state === 'degraded' &&
                    res.keepAliveRelease.message
                )
                    warnings.push(
                        `agent ${a.id}: ${res.keepAliveRelease.message}`
                    )
            } catch (err) {
                warnings.push(
                    `agent ${a.id} stop failed: ${(err as Error).message}`
                )
            }
        }
        // Orphan runtimes (no agent row) and agents whose lagging status row
        // made stopSprite noop are invisible to the loop above AND to both
        // keep-alive reconcile passes — release them directly.
        const runtimesOnHost = await this.runtimes.listRuntimesByHost(hostId)
        for (const rt of runtimesOnHost) {
            if (handledRuntimeIds.has(rt.id)) continue
            try {
                if (rt.keepAliveEnabled)
                    await this.runtimes.setKeepAliveEnabled(rt.id, false)
                const release = await this.keepAliveLease.stopAndRelease(
                    rt,
                    'sandbox-stop'
                )
                if (release.state !== 'not_applicable')
                    estimate = Math.max(estimate, release.maxStaleSec)
                if (release.state === 'degraded' && release.message)
                    warnings.push(`runtime ${rt.id}: ${release.message}`)
            } catch (err) {
                warnings.push(
                    `runtime ${rt.id} keep-alive release failed: ${(err as Error).message}`
                )
            }
        }

        // Stop (not delete) non-managed services. The platform silently
        // refuses to stop a service another one `needs` — the returned state
        // stays running — so sweep in passes (each pass can unblock the next)
        // and surface whatever still refuses as warnings.
        const client = this.spritesClientFor(
            await this.requireAccount(host.accountId)
        )
        const stoppedServices: string[] = []
        const services = await this.readServicesOnSprite(client, spriteName)
        let pending = services.filter(
            (s) =>
                !isServiceFrameworkName(s.name) && s.state.status !== 'stopped'
        )
        for (
            let pass = 0;
            pending.length > 0 && pass < services.length;
            pass++
        ) {
            const refused: typeof pending = []
            for (const svc of pending) {
                try {
                    const after = await client.stopService(
                        spriteName,
                        svc.name
                    )
                    if (after.state.status === 'stopped')
                        stoppedServices.push(svc.name)
                    else refused.push(svc)
                } catch (err) {
                    if (
                        err instanceof SpritesError &&
                        err.code === 'not_found'
                    )
                        stoppedServices.push(svc.name)
                    else
                        warnings.push(
                            `failed to stop service '${svc.name}': ${(err as Error).message}`
                        )
                }
            }
            if (refused.length === pending.length) {
                pending = refused
                break
            }
            pending = refused
        }
        for (const svc of pending)
            warnings.push(
                `service '${svc.name}' refused to stop (another service may depend on it)`
            )

        // Delete non-platform activity tasks. Platform leases were already
        // released with their renewers killed above; deleting a stray one here
        // would just be resurrected by its in-VM renew loop.
        const deletedTasks: string[] = []
        const tasksOnSprite = await this.readTasksOnSprite(client, spriteName)
        for (const t of tasksOnSprite) {
            if (typeof t.name !== 'string' || isPlatformTaskName(t.name))
                continue
            const remaining = await this.deleteTaskOnSprite(
                client,
                spriteName,
                t.name
            )
            if (remaining.some((x) => x.name === t.name))
                warnings.push(
                    `task '${t.name}' is still registered — a process inside the sandbox re-registered it`
                )
            else deletedTasks.push(t.name)
        }

        await this.spriteStatusSync
            .refreshSandboxHost(host)
            .catch((err: Error) => {
                warnings.push(`status refresh failed: ${err.message}`)
            })

        // Agents, runtimes, services and tasks are the complete set of levers a
        // stop has, and none of them existed on this running VM. Whatever is
        // keeping it awake is out of reach, so this stop cannot put it to sleep
        // however successful its counters look. Said out loud last, as a
        // verdict on the whole attempt, because a caller retrying on a timer
        // otherwise never learns it is powerless — Seen on prod [2026-09-03]: a
        // free-plan sandbox with a deleted agent and two leaked exec sessions
        // absorbed 60 of these in one day, each audited as `pending` with empty
        // arrays, while it billed 52h against a 5h quota.
        const hasNoLevers =
            agentsOnHost.length === 0 &&
            runtimesOnHost.length === 0 &&
            services.length === 0 &&
            tasksOnSprite.length === 0
        if (hasNoLevers) {
            warnings.push(
                'nothing on this sandbox could be stopped: it is running with no agents, runtimes, services or tasks registered on it, so something out of reach is holding it awake and it will not sleep'
            )
            this.log.warn(
                `sandbox stop has no levers host=${hostId} sprite=${spriteName} user=${host.userId} — running with nothing registered on it`
            )
        }

        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: userId,
                action: auditAction.SANDBOX_STOP,
                subject: hostId,
                meta: {
                    spriteName,
                    stoppedAgents,
                    stoppedServices,
                    deletedTasks,
                    hasNoLevers,
                    warnings: warnings.length,
                    onBehalfOf:
                        isAdmin && host.userId !== userId ? host.userId : null
                }
            })
        } catch (err) {
            this.log.warn(
                `audit write failed for sandbox.stop host=${hostId}: ${(err as Error).message}`
            )
        }
        return {
            status: 'pending',
            stoppedAgents,
            stoppedServices,
            deletedTasks,
            estimatedReadyInSec: estimate,
            warnings
        }
    }

    // One exec round-trip: delete, then re-list to verify; returns the
    // remaining task list. The task name is agent-controlled, so it is
    // URL-encoded in Node and transported via exec env — never interpolated
    // into the shell line. `sprite-env curl` rejects `-f`, so the trailing
    // list is the only success signal.
    private async deleteTaskOnSprite(
        client: SpritesClient,
        spriteName: string,
        name: string
    ): Promise<Array<{ name?: unknown }>> {
        const result = await this.exec(client, spriteName, {
            cmd: [
                'bash',
                '-lc',
                'sprite-env curl -s -X DELETE "/v1/tasks/$NCA_TASK_NAME" >/dev/null 2>&1; sprite-env curl -s /v1/tasks'
            ],
            env: { NCA_TASK_NAME: encodeURIComponent(name) },
            stdin: '',
            timeoutMs: 20_000,
            keepAliveMs: 5_000,
            livenessTimeoutMs: 12_000
        }).catch((err: Error) => {
            throw new ServiceUnavailableException(
                `failed to delete task '${name}' on ${spriteName}: ${err.message}`
            )
        })
        // Unlike readTasksOnSprite, an unreadable verify list is an error — a
        // lenient fallback would report success whenever the verify curl failed.
        try {
            if (result.exitCode !== 0) throw new Error('task list read failed')
            const body = JSON.parse(result.stdout.trim()) as {
                tasks?: Array<{ name?: unknown }>
            }
            return body.tasks ?? []
        } catch {
            throw new ServiceUnavailableException(
                `could not verify task deletion on ${spriteName}`
            )
        }
    }

    private async requireProvisionedSandbox(
        userId: string,
        hostId: string,
        isAdmin: boolean
    ): Promise<{ spriteName: string; accountId: string }> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        const { host } = r
        if (!host.spriteId || !host.spriteName || !host.accountId)
            throw new BadRequestException('sandbox is not provisioned')
        return { spriteName: host.spriteName, accountId: host.accountId }
    }

    private async requireAccount(accountId: string): Promise<SpritesAccount> {
        const account = await this.accounts.getById(accountId)
        if (!account)
            throw new BadRequestException('sandbox account unavailable')
        return account
    }

    // Seam so tests can fake the sprites.dev control-plane client.
    protected spritesClientFor(account: SpritesAccount): SpritesClient {
        return createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
    }

    // Seam so tests can fake the sprite exec transport.
    protected exec(
        client: SpritesClient,
        spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        return execSprite(client, spriteName, opts)
    }

    private async probeSpriteFrameworks(
        accountId: string,
        spriteName: string
    ): Promise<{
        frameworks: DetectedFramework[]
        cliVersion: string | null
    } | null> {
        const account = await this.accounts.getById(accountId)
        if (!account) return null
        const shell = [
            'export PATH="$HOME/.local/bin:$PATH"',
            ...SPRITE_CODING_FRAMEWORKS.map((f) => {
                const bin = frameworkVersionDescriptor(f).binName
                return `echo "${f}=$(${bin} --version 2>/dev/null | head -1)"`
            }),
            // The platform-managed mf CLI baked into the sprite image (used for
            // agent auth / a2a). Surfaced as the sandbox's "mf CLI version".
            'echo "mf=$(mf --version 2>/dev/null | head -1)"'
        ].join('; ')
        try {
            const client = createSpritesClient({
                token: this.accounts.decryptToken(account),
                accountSlug: account.slug
            })
            const result = await execSprite(client, spriteName, {
                cmd: ['bash', '-lc', shell],
                stdin: '',
                timeoutMs: DETECT_TIMEOUT_MS
            })
            return parseSpriteFrameworkProbe(
                `${result.stdout}\n${result.stderr}`
            )
        } catch (err) {
            this.log.warn(
                `detect-frameworks probe failed for sandbox ${spriteName}: ${(err as Error).message}`
            )
            return null
        }
    }
}

/**
 * Read the `<framework>=<--version output>` / `mf=<--version output>` lines the
 * detect shell above prints.
 *
 * Exported, and split out of the probe, because the parser this picks is the
 * whole contract: every version it returns is PERSISTED (runtime_hosts.cliVersion
 * and agent_runtimes.framework_version), so it must keep the full string —
 * prerelease suffix included. parseProbedVersion would truncate
 * `0.22.5-staging.<stamp>.<sha>` to `0.22.5`, and the staging update check
 * compares by string equality (isCliUpdateAvailable, since build stamps are not
 * semver-comparable), so a sandbox on the exact latest build was told to update
 * forever (#777). Behind the sprite exec that choice was untestable.
 */
export const parseSpriteFrameworkProbe = (
    output: string
): { frameworks: DetectedFramework[]; cliVersion: string | null } => {
    const lines = output.split('\n')
    const frameworks: DetectedFramework[] = []
    for (const f of SPRITE_CODING_FRAMEWORKS) {
        const line = lines.find((l) => l.startsWith(`${f}=`))
        const version = parseProbedSemver(line ? line.slice(f.length + 1) : '')
        if (version)
            frameworks.push({
                framework: f,
                version,
                path: `~/.local/bin/${frameworkVersionDescriptor(f).binName}`
            })
    }
    const mfLine = lines.find((l) => l.startsWith('mf='))
    const cliVersion = parseProbedSemver(
        mfLine ? mfLine.slice('mf='.length) : ''
    )
    return { frameworks, cliVersion }
}

const toSandboxSummary = (
    host: RuntimeHostRow,
    accountSlug: string | null,
    agentsCount: number,
    latest: LatestCliVersion,
    activeSecondsThisPeriod: number
): SandboxSummary => ({
    id: host.id,
    userId: host.userId,
    name: host.name,
    accountSlug,
    spriteName: host.spriteName,
    spriteStatus: host.spriteStatus,
    terminalEnabled: host.terminalEnabled,
    terminalModelCredentials: host.terminalModelCredentials,
    agentsCount,
    detectedFrameworks: host.detectedFrameworks,
    cliVersion: host.cliVersion,
    latestCliVersion: latest.version,
    cliUpdateAvailable: isCliUpdateAvailable(
        latest.channel,
        host.cliVersion,
        latest.version
    ),
    activeSecondsThisPeriod,
    emptiedAt: host.emptiedAt ? host.emptiedAt.toISOString() : null,
    createdAt: host.createdAt.toISOString(),
    updatedAt: host.updatedAt.toISOString()
})

const toServiceSummary = (s: ServiceObject): SandboxServiceSummary => ({
    name: s.name,
    command: [s.cmd, ...(s.args ?? [])].join(' '),
    httpPort: s.http_port ?? null,
    status: s.state.status,
    pid: s.state.pid ?? null,
    startedAt: s.state.started_at ?? null,
    error: s.state.error ?? null,
    managed: isServiceFrameworkName(s.name)
})
