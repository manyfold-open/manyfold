import {
    auditAction,
    type ProviderMachineAction,
    type ProviderMachineHost,
    type ProviderMachineList,
    type ProviderMachineRestartResult,
    type ProviderMachineSummary,
    type ProviderMachineUpgradeResult,
    type UpgradeProviderMachineBody
} from '@manyfold/shared'
import {
    BadGatewayException,
    ConflictException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm'
import {
    auditLogs,
    runtimeHosts,
    users,
    type Database,
    type RuntimeProvider
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { HostedHostLifecycleService } from '@/modules/agent-runtimes/hosted-host-lifecycle.service'
import { RuntimeProvidersService } from '@/modules/hosts/runtime-providers.service'
import {
    ProviderMachineError,
    SandboxProviderRegistry,
    type ProviderInventory,
    type ProviderMachine,
    type ProviderMachineListing
} from '@/modules/hosts/providers/sandbox-provider'

// A provider account lists in one read, but an admin page polls it and two
// admins may look at once; this long is old enough to share and new enough
// to act on. Every action re-reads hosts from the database regardless.
const LISTING_TTL_MS = 10_000
const RECENT_ACTIONS = 20

// A host this far into being made or torn down owns its machine's state; a
// restart or upgrade under it would race the lifecycle.
const BUSY_HOST_STATUSES = new Set(['provisioning', 'deleting'])

export const machineSubject = (providerId: string, name: string): string =>
    `machine:${providerId}/${name}`

interface Account {
    provider: RuntimeProvider
    inventory: ProviderInventory
    key: string
    // Every row of this kind on the same account, the page's own included.
    rows: RuntimeProvider[]
}

interface ListingEntry {
    startedAt: number
    settled: boolean
    promise: Promise<ProviderMachineListing>
}

export interface UpgradeEvents {
    onAccepted?: (fromVersion: string | null) => void
    onStep?: (step: string) => void
}

// An inventory failure as the HTTP error an admin sees.
const httpError = (err: unknown): unknown => {
    if (!(err instanceof ProviderMachineError)) return err
    const body = (code: string) => ({ message: err.message, code })
    switch (err.kind) {
        case 'not_found':
            return new NotFoundException(body('PROVIDER_MACHINE_NOT_FOUND'))
        case 'unsupported':
            return new ConflictException(
                body('PROVIDER_MACHINE_ACTION_UNSUPPORTED')
            )
        case 'refused':
            return new ConflictException(
                body('PROVIDER_MACHINE_ACTION_REFUSED')
            )
        case 'storage_migration_required':
            return new ConflictException(
                body('PROVIDER_MACHINE_STORAGE_MIGRATION_REQUIRED')
            )
        case 'rate_limited':
            return new HttpException(
                {
                    ...body('PROVIDER_RATE_LIMITED'),
                    retryAfterSec: Math.max(
                        1,
                        Math.ceil((err.retryAfterMs ?? 0) / 1000)
                    )
                },
                HttpStatus.TOO_MANY_REQUESTS
            )
        case 'auth':
            return new BadGatewayException(body('PROVIDER_AUTH_FAILED'))
        default:
            return new ServiceUnavailableException(body('PROVIDER_UNAVAILABLE'))
    }
}

const rethrown = (err: unknown): never => {
    throw httpError(err)
}

// The machines of a provider's account, tracked by a host here or not, and
// the provider's own operations on one of them (ADR-0044). A machine with a
// host is deleted through the host lifecycle, so no host is ever left
// pointing at a machine that is gone.
@Injectable()
export class RuntimeProviderMachinesService {
    private readonly log = new Logger(RuntimeProviderMachinesService.name)
    private readonly listings = new Map<string, ListingEntry>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly providers: RuntimeProvidersService,
        private readonly registry: SandboxProviderRegistry,
        private readonly lifecycle: HostedHostLifecycleService
    ) {}

    async list(
        providerId: string,
        opts: { refresh?: boolean } = {}
    ): Promise<ProviderMachineList> {
        const account = await this.account(providerId)
        const entry = this.listing(account, opts.refresh === true)
        const [listing, hosts] = await Promise.all([
            entry.promise.catch(rethrown),
            this.hostsByMachine(account)
        ])
        return {
            providerId,
            sharedWith: account.rows
                .filter((row) => row.id !== providerId)
                .map((row) => ({ id: row.id, name: row.name })),
            complete: listing.complete,
            listedAt: new Date(entry.startedAt).toISOString(),
            capacity: listing.capacity,
            machines: listing.machines.map((machine) =>
                toSummary(machine, hosts.get(machine.name) ?? null)
            )
        }
    }

    async get(
        providerId: string,
        name: string
    ): Promise<ProviderMachineSummary> {
        const account = await this.account(providerId)
        const [machine, hosts] = await Promise.all([
            account.inventory.get(account.provider, name).catch(rethrown),
            this.hostsByMachine(account)
        ])
        if (!machine) throw notFound(name)
        return toSummary(machine, hosts.get(name) ?? null)
    }

    // audit_logs has no index on subject, so this is read once per page view
    // and after an action, never on a poll.
    async actions(
        providerId: string,
        name: string
    ): Promise<ProviderMachineAction[]> {
        const account = await this.account(providerId)
        const rows = await this.db
            .select({
                id: auditLogs.id,
                action: auditLogs.action,
                meta: auditLogs.meta,
                createdAt: auditLogs.createdAt,
                actorEmail: users.email
            })
            .from(auditLogs)
            .leftJoin(users, sql`${auditLogs.actorId} = 'user:' || ${users.id}`)
            .where(
                and(
                    inArray(
                        auditLogs.subject,
                        account.rows.map((row) => machineSubject(row.id, name))
                    ),
                    like(auditLogs.action, 'runtime_provider.machine.%')
                )
            )
            .orderBy(desc(auditLogs.createdAt))
            .limit(RECENT_ACTIONS)
        return rows.map((row) => ({
            id: row.id,
            action: row.action,
            actorEmail: row.actorEmail ?? null,
            createdAt: row.createdAt.toISOString(),
            meta: (row.meta ?? {}) as Record<string, unknown>
        }))
    }

    async restart(
        actorUserId: string,
        providerId: string,
        name: string
    ): Promise<ProviderMachineRestartResult> {
        const account = await this.account(providerId)
        const restart = account.inventory.restart
        if (!restart) throw unsupported(name)
        const host = await this.actionableHost(account, name)
        const result = await restart(account.provider, name).catch(rethrown)
        this.forgetListing(account)
        await this.audit(
            actorUserId,
            auditAction.RUNTIME_PROVIDER_MACHINE_RESTARTED,
            account,
            name,
            host
        )
        return { message: result.message }
    }

    // Watched to its end even when the admin who asked has gone, so the
    // outcome still lands in the audit log; the provider carries the upgrade
    // on regardless of who is watching.
    async upgrade(
        actorUserId: string,
        providerId: string,
        name: string,
        body: UpgradeProviderMachineBody,
        events: UpgradeEvents = {}
    ): Promise<ProviderMachineUpgradeResult> {
        const account = await this.account(providerId)
        const upgrade = account.inventory.upgrade
        if (!upgrade) throw unsupported(name)
        const machine = await account.inventory
            .get(account.provider, name)
            .catch(rethrown)
        if (!machine) throw notFound(name)
        const host = await this.actionableHost(account, name)
        // The provider keeps no record of the version it upgraded from; this
        // row is where a rollback finds it.
        const fromVersion = machine.version
        const started = {
            fromVersion,
            requestedVersion: body.version ?? null,
            allowStorageMigration: body.allowStorageMigration === true
        }
        let startedAudit: Promise<void> | null = null
        const outcome = await upgrade(
            account.provider,
            name,
            {
                version: body.version,
                allowStorageMigration: body.allowStorageMigration
            },
            {
                onAccepted: () => {
                    startedAudit = this.audit(
                        actorUserId,
                        auditAction.RUNTIME_PROVIDER_MACHINE_UPGRADE_STARTED,
                        account,
                        name,
                        host,
                        started
                    )
                    events.onAccepted?.(fromVersion)
                },
                onStep: events.onStep
            }
        ).catch(rethrown)
        this.forgetListing(account)
        // The start is on record before the end is.
        await startedAudit
        const result: ProviderMachineUpgradeResult = {
            outcome: outcome.outcome,
            message: outcome.message,
            fromVersion,
            targetVersion: outcome.targetVersion,
            lastStep: outcome.lastStep
        }
        const terminal = {
            completed: auditAction.RUNTIME_PROVIDER_MACHINE_UPGRADE_SUCCEEDED,
            skipped: auditAction.RUNTIME_PROVIDER_MACHINE_UPGRADE_SKIPPED,
            failed: auditAction.RUNTIME_PROVIDER_MACHINE_UPGRADE_FAILED,
            unconfirmed: null
        }[outcome.outcome]
        if (terminal)
            await this.audit(actorUserId, terminal, account, name, host, {
                fromVersion,
                targetVersion: outcome.targetVersion,
                ...(outcome.outcome === 'completed'
                    ? {}
                    : { reason: outcome.message })
            })
        else
            this.log.warn(
                `upgrade of ${name} on ${account.provider.name} left unwatched at ${outcome.lastStep ?? 'its start'}; the provider may still finish it`
            )
        return result
    }

    async delete(
        actorUserId: string,
        providerId: string,
        name: string
    ): Promise<void> {
        const account = await this.account(providerId)
        const host = (await this.hostsByMachine(account)).get(name) ?? null
        if (host) {
            await this.lifecycle.deleteHost(host.id)
        } else {
            const machine = await account.inventory
                .get(account.provider, name)
                .catch(rethrown)
            if (!machine) throw notFound(name)
            await account.inventory
                .destroy(account.provider, name)
                .catch(rethrown)
        }
        this.forgetListing(account)
        await this.audit(
            actorUserId,
            auditAction.RUNTIME_PROVIDER_MACHINE_DELETED,
            account,
            name,
            host,
            { via: host ? 'host_lifecycle' : 'provider' }
        )
    }

    private async account(providerId: string): Promise<Account> {
        const provider = await this.providers.findById(providerId)
        if (!provider)
            throw new NotFoundException(
                `runtime provider ${providerId} not found`
            )
        const adapter = this.registry.has(provider.kind)
            ? this.registry.for(provider.kind)
            : null
        const inventory = adapter?.inventory
        if (!inventory)
            throw new ConflictException({
                message: `a ${provider.kind} provider has no inventory`,
                code: 'RUNTIME_PROVIDER_INVENTORY_UNSUPPORTED'
            })
        const key = inventory.accountKey(provider)
        const rows = (await this.providers.list(provider.kind)).filter(
            (row) => inventory.accountKey(row) === key
        )
        return {
            provider,
            inventory,
            key,
            rows: rows.some((row) => row.id === provider.id)
                ? rows
                : [provider, ...rows]
        }
    }

    private listing(account: Account, refresh: boolean): ListingEntry {
        const now = Date.now()
        const current = this.listings.get(account.key)
        // A refresh still joins a listing already on its way.
        if (
            current &&
            (!current.settled ||
                (!refresh && now - current.startedAt < LISTING_TTL_MS))
        )
            return current
        const entry: ListingEntry = {
            startedAt: now,
            settled: false,
            promise: account.inventory.list(account.provider)
        }
        entry.promise.then(
            () => {
                entry.settled = true
            },
            () => {
                if (this.listings.get(account.key) === entry)
                    this.listings.delete(account.key)
            }
        )
        this.listings.set(account.key, entry)
        return entry
    }

    private forgetListing(account: Account): void {
        this.listings.delete(account.key)
    }

    // Every hosted host on the account's rows, in any status: one whose
    // create never recorded its machine still owns the name it would have.
    private async hostsByMachine(
        account: Account
    ): Promise<Map<string, ProviderMachineHost>> {
        const rows = await this.db
            .select({
                id: runtimeHosts.id,
                name: runtimeHosts.name,
                status: runtimeHosts.status,
                userId: runtimeHosts.userId,
                providerId: runtimeHosts.providerId,
                providerRef: runtimeHosts.providerRef,
                createdAt: runtimeHosts.createdAt,
                ownerEmail: users.email,
                agentsCount: sql<number>`(select count(*) from agents a join agent_runtimes r on r.id = a.runtime_id where r.host_id = ${runtimeHosts.id})::int`
            })
            .from(runtimeHosts)
            .leftJoin(users, eq(users.id, runtimeHosts.userId))
            .where(
                and(
                    eq(runtimeHosts.kind, 'hosted'),
                    inArray(
                        runtimeHosts.providerId,
                        account.rows.map((row) => row.id)
                    )
                )
            )
        const names = new Map(account.rows.map((row) => [row.id, row.name]))
        const claims = new Map<string, (typeof rows)[number]>()
        for (const row of rows) {
            const name = account.inventory.machineNameOf(row)
            const held = claims.get(name)
            if (held) {
                this.log.warn(
                    `machine ${name} claimed by hosts ${held.id} and ${row.id}`
                )
                // A recorded name beats a derived one; then the newer host.
                const heldWins =
                    (held.providerRef !== null) !== (row.providerRef !== null)
                        ? held.providerRef !== null
                        : held.createdAt >= row.createdAt
                if (heldWins) continue
            }
            claims.set(name, row)
        }
        const hosts = new Map<string, ProviderMachineHost>()
        for (const [name, row] of claims)
            hosts.set(name, {
                id: row.id,
                name: row.name,
                status: row.status,
                userId: row.userId,
                ownerEmail: row.ownerEmail ?? null,
                agentsCount: Number(row.agentsCount),
                providerId: row.providerId ?? account.provider.id,
                providerName:
                    names.get(row.providerId ?? '') ?? account.provider.name
            })
        return hosts
    }

    // A restart or upgrade under a host still being made or torn down would
    // race the lifecycle that owns the machine then.
    private async actionableHost(
        account: Account,
        name: string
    ): Promise<ProviderMachineHost | null> {
        const host = (await this.hostsByMachine(account)).get(name) ?? null
        if (host && BUSY_HOST_STATUSES.has(host.status))
            throw new ConflictException({
                message: `sandbox ${host.name} is ${host.status}`,
                code: 'PROVIDER_MACHINE_HOST_BUSY'
            })
        return host
    }

    private async audit(
        actorUserId: string,
        action: string,
        account: Account,
        name: string,
        host: ProviderMachineHost | null,
        meta: Record<string, unknown> = {}
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: `user:${actorUserId}`,
                action,
                subject: machineSubject(account.provider.id, name),
                meta: {
                    providerId: account.provider.id,
                    providerKind: account.provider.kind,
                    machineName: name,
                    hostId: host?.id ?? null,
                    hostUserId: host?.userId ?? null,
                    ...meta
                }
            })
        } catch (err) {
            this.log.warn(
                `audit write failed for ${action} machine=${name}: ${(err as Error).message}`
            )
        }
    }
}

const notFound = (name: string): NotFoundException =>
    new NotFoundException({
        message: `no machine ${name} in this account`,
        code: 'PROVIDER_MACHINE_NOT_FOUND'
    })

const unsupported = (name: string): ConflictException =>
    new ConflictException({
        message: `this provider does not offer that for ${name}`,
        code: 'PROVIDER_MACHINE_ACTION_UNSUPPORTED'
    })

const toSummary = (
    machine: ProviderMachine,
    host: ProviderMachineHost | null
): ProviderMachineSummary => ({ ...machine, host })
