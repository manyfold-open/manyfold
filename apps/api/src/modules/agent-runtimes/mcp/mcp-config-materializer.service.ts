import {
    AgentFramework,
    AgentMcpDeliveryScopeResult,
    frameworkMcpSupport,
    mcpConfigFromExtras
} from '@manyfold/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    createClient as createSpritesClient,
    spriteReadFile,
    spriteWriteFile,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import {
    agentRuntimes,
    type Agent,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import {
    daemonConfigRead,
    daemonConfigWrite,
    daemonConfigRpc
} from '@/modules/daemon/daemon-fs'
import { DaemonConfigDeliveryService, DaemonConfigDeliveryError, type DaemonConfigSnapshot, type DaemonConfigDeliveryOptions } from '@/modules/daemon/daemon-config-delivery.service'
import { decryptComposioKey } from '@/modules/connections/composio-key'
import { COMPOSIO_MCP_SERVER_NAME } from '@/modules/connections/composio.service'
import {
    composioInjectScope,
    composioMcpServerJson
} from '@/modules/agent-runtimes/mcp/composio-mcp'
import {
    computeDesired,
    resolveMcpScopeTargets,
    type McpInjection,
    type McpScopeTarget
} from '@/modules/agent-runtimes/mcp/mcp-config'

// One read-modify-write surface per runtime kind. The sprite impl wraps the
// sprites fs client; the daemon impl drives the CLI's fs RPCs (#781).
export interface ScopeFileIo {
    read(absPath: string): Promise<string | null>
    write(absPath: string, text: string): Promise<void>
    commit?(absPath: string, text: string | null, previous: string | null): Promise<'delivered' | 'unchanged'>
}

export interface MaterializeMcpArgs {
    io: ScopeFileIo
    targetLabel: string
    framework: AgentFramework
    homeDir: string
    workspacePath: string
    // scopeId -> raw framework-native MCP text; missing/empty clears that scope.
    mcp: Record<string, string>
    // Agent owner + linked Composio connection: when set, the decrypted key is
    // injected as a managed `composio` server into the framework's home-dir scope.
    userId: string
    composioConnectionId?: string | null
    composioKey?: string | null
    safeErrors?: boolean
}

export const spriteScopeIo = (
    client: SpritesClient,
    spriteName: string,
    logger: SpritesLogger,
    timeoutMs?: number
): ScopeFileIo => ({
    read: (absPath) => readFileText(client, spriteName, absPath, logger),
    write: async (absPath, text) => {
        await spriteWriteFile(
            client,
            spriteName,
            {
                absPath,
                body: Buffer.from(text, 'utf8'),
                mode: '600',
                timeoutMs
            },
            logger
        )
    }
})

// Writes per-scope MCP config into a coding agent's runtime. DB (agent.extras.mcp)
// is the source of truth; this projects it onto each framework's real config
// file via read-modify-write (no jq on the target, no heredoc). Every write is
// idempotent and per-scope best-effort so one bad scope never aborts the rest;
// the outcome is returned per scope so callers can persist or surface it.
@Injectable()
export class McpConfigMaterializer {
    private readonly log = new Logger(McpConfigMaterializer.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly crypto: CryptoService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly delivery: DaemonConfigDeliveryService
    ) {}

    async materialize(
        args: MaterializeMcpArgs
    ): Promise<AgentMcpDeliveryScopeResult[]> {
        const targets = resolveMcpScopeTargets(args.framework, {
            homeDir: args.homeDir,
            workspacePath: args.workspacePath
        })
        // Decrypt the linked Composio key once (best-effort). It's injected as a
        // managed `composio` server into one home-dir scope; a failure logs and
        // skips only the injection, never the user's own MCP scopes.
        let composioKey: string | null = null
        try {
            composioKey = args.composioKey !== undefined ? args.composioKey : await decryptComposioKey(
                this.db,
                this.crypto,
                args.userId,
                args.composioConnectionId
            )
        } catch (err) {
            if (args.safeErrors) throw new DaemonConfigDeliveryError('failed')
            this.log.warn(
                `composio key resolve failed on ${args.targetLabel}: ${(err as Error).message}`
            )
        }
        const injectScope = composioKey
            ? composioInjectScope(args.framework)
            : null
        const results: AgentMcpDeliveryScopeResult[] = []
        for (const target of targets) {
            const text = (args.mcp[target.scopeId] ?? '').trim()
            const injection =
                composioKey && target.scopeId === injectScope
                    ? composioInjection(args.framework, composioKey)
                    : undefined
            try {
                results.push({
                    scopeId: target.scopeId,
                    status: await this.writeScope(
                        args.io,
                        target,
                        text,
                        injection
                    )
                })
            } catch (err) {
                if (args.safeErrors) {
                    this.log.warn(`daemon configuration mcp scope ${target.scopeId} failed`)
                    results.push({ scopeId: target.scopeId, status: 'failed', message: 'Configuration delivery failed; reconnect or retry the push.' })
                    continue
                }
                this.log.warn(
                    `mcp materialize ${args.framework}/${target.scopeId} on ${args.targetLabel} failed: ${(err as Error).message}`
                )
                results.push({
                    scopeId: target.scopeId,
                    status: 'failed',
                    message: (err as Error).message
                })
            }
        }
        return results
    }

    // Synchronous push for one agent, shared by the explicit materialize
    // endpoint and the on-change refresh. Throws for shapes that cannot take a
    // push at all; per-scope outcomes never throw. Daemon outcomes persist to
    // extras.mcpDelivery — a daemon has no bootstrap to re-materialize at, so
    // an offline save must leave a durable stale marker (#781).
    async materializeForAgent(
        agent: Agent,
        options: DaemonConfigDeliveryOptions = {}
    ): Promise<AgentMcpDeliveryScopeResult[]> {
        if (!frameworkMcpSupport(agent.framework))
            throw new Error(
                `${agent.framework} agents do not support MCP servers`
            )
        if (agent.runtime === 'sprites')
            return this.materializeSprite(agent)
        if (agent.runtime === 'daemon') return this.materializeDaemon(agent, options)
        throw new Error(
            `MCP config cannot be pushed to a ${agent.runtime} runtime`
        )
    }

    // Best-effort push after the user edits MCP or links Composio. Never
    // throws — the caller uses `void`; sprites re-materialize at next
    // bootstrap, daemons keep the persisted per-scope outcome instead.
    async refreshOnChange(agent: Agent): Promise<void> {
        try {
            if (agent.runtime !== 'sprites' && agent.runtime !== 'daemon')
                return
            if (!frameworkMcpSupport(agent.framework)) return
            await this.materializeForAgent(agent)
        } catch (err) {
            if (agent.runtime === 'daemon') { this.log.warn('daemon configuration mcp refresh deferred'); return }
            this.log.warn(
                `mcp refresh failed for ${agent.id}: ${(err as Error).message}`
            )
        }
    }

    private async materializeSprite(
        agent: Agent
    ): Promise<AgentMcpDeliveryScopeResult[]> {
        if (!agent.spriteName || !agent.accountId || !agent.runtimeId)
            throw new Error(`agent ${agent.id} is missing its sprite identity`)
        const homeDir = await this.runtimeHomeDir(agent.runtimeId)
        if (!homeDir)
            throw new Error(
                `runtime home dir unknown for ${agent.id} (not bootstrapped yet)`
            )
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new Error(`sprites account ${agent.accountId} not found`)
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
        return this.materialize({
            io: spriteScopeIo(
                client,
                agent.spriteName,
                spritesLoggerFrom(this.log)
            ),
            targetLabel: agent.spriteName,
            framework: agent.framework,
            homeDir,
            workspacePath: agent.workspacePath ?? agent.mountPath,
            mcp: mcpConfigFromExtras(agent.extras),
            userId: agent.userId,
            composioConnectionId: composioConnectionIdOf(agent)
        })
    }

    private async materializeDaemon(
        agent: Agent,
        options: DaemonConfigDeliveryOptions
    ): Promise<AgentMcpDeliveryScopeResult[]> {
        return this.delivery.deliver(
            agent,
            async (snapshot, attempt) => {
                const current = snapshot.agent
                const daemonId = current.daemonId!
                const revision = snapshot.revision('mcp')
                if (options.automatic && this.delivered(snapshot)) return []
                const support = frameworkMcpSupport(current.framework)
                if (!support) return []
                let results: AgentMcpDeliveryScopeResult[]
                if (options.automatic && !attempt.protectedWrites)
                    results = support.scopes.map((scope) => ({
                        scopeId: scope.id,
                        status: 'skipped',
                        message:
                            'Upgrade the daemon CLI for automatic configuration delivery.'
                    }))
                else if (!snapshot.runtime.homeDir)
                    results = support.scopes.map((scope) => ({
                        scopeId: scope.id,
                        status: 'failed',
                        message: 'Runtime home directory is unavailable.'
                    }))
                else {
                    try {
                        const key = snapshot.connections.find(
                            (row) =>
                                row.id ===
                                    current.extras.composioConnectionId &&
                                row.provider === 'composio' &&
                                !row.revokedAt
                        )
                        let composioKey: string | null = null
                        if (key?.secretCiphertext)
                            composioKey = this.crypto.decrypt({
                                ciphertext: key.secretCiphertext,
                                keyVersion: key.keyVersion
                            })
                        results = await this.materialize({
                            io: {
                                read: (path) =>
                                    daemonConfigRead(
                                        this.daemonRegistry,
                                        daemonId,
                                        path,
                                        attempt
                                    ),
                                write: async (path, text) => {
                                    await daemonConfigRpc(
                                        this.daemonRegistry,
                                        daemonId,
                                        'fs.write',
                                        { path, content: text, mode: '600' },
                                        attempt
                                    )
                                },
                                ...(attempt.protectedWrites
                                    ? {
                                          commit: (
                                              path: string,
                                              text: string | null,
                                              previous: string | null
                                          ) =>
                                              daemonConfigWrite(
                                                  this.daemonRegistry,
                                                  daemonId,
                                                  path,
                                                  text,
                                                  previous,
                                                  revision,
                                                  attempt
                                              )
                                      }
                                    : {})
                            },
                            targetLabel: 'daemon configuration',
                            framework: current.framework,
                            homeDir: snapshot.runtime.homeDir,
                            workspacePath:
                                current.workspacePath ?? current.mountPath,
                            mcp: mcpConfigFromExtras(current.extras),
                            userId: current.userId,
                            composioKey,
                            safeErrors: true
                        })
                    } catch {
                        results = support.scopes.map((scope) => ({
                            scopeId: scope.id,
                            status: 'failed',
                            message:
                                'Configuration delivery failed; reconnect or retry the push.'
                        }))
                    }
                }
                const record = Object.fromEntries(
                    results.map((result) => [
                        result.scopeId,
                        {
                            status:
                                result.status === 'unchanged'
                                    ? 'delivered'
                                    : result.status,
                            ...(result.message
                                ? { message: result.message }
                                : {}),
                            at: new Date().toISOString()
                        }
                    ])
                )
                const published = await attempt.publish(snapshot, 'mcp', {
                    mcpDelivery: record,
                    mcpDeliveryRevision: revision
                })
                if (!published) throw new DaemonConfigDeliveryError('changed')
                return results
            },
            options
        )
    }

    delivered(snapshot: DaemonConfigSnapshot): boolean {
        const support = frameworkMcpSupport(snapshot.agent.framework)
        const record = snapshot.agent.extras.mcpDelivery as
            Record<string, { status?: string }> | undefined
        return (
            !!support &&
            snapshot.agent.extras.mcpDeliveryRevision ===
                snapshot.revision('mcp') &&
            support.scopes.every(
                (scope) => record?.[scope.id]?.status === 'delivered'
            )
        )
    }

    private async runtimeHomeDir(runtimeId: string): Promise<string | null> {
        const [runtime] = await this.db
            .select({ homeDir: agentRuntimes.homeDir })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        return runtime?.homeDir ?? null
    }

    private async writeScope(
        io: ScopeFileIo,
        target: McpScopeTarget,
        text: string,
        injection: McpInjection | undefined
    ): Promise<'delivered' | 'unchanged'> {
        const current = await io.read(target.absPath)
        const desired = computeDesired(target, current, text, injection)
        if (io.commit) return io.commit(target.absPath, desired ?? current, current)
        if (desired === null || desired === current) return 'unchanged'
        await io.write(target.absPath, desired)
        return 'delivered'
    }
}

const composioConnectionIdOf = (agent: Agent): string | null | undefined =>
    (agent.extras as { composioConnectionId?: string | null })
        .composioConnectionId

const isComposioJsonFramework = (
    framework: AgentFramework
): framework is 'claude-code' | 'gemini-cli' =>
    framework === 'claude-code' || framework === 'gemini-cli'

// Build the managed composio injection in the shape the target scope's format
// expects: a server object for JSON frameworks, the raw key for Codex (merged
// into TOML downstream). Framework is already narrowed by composioInjectScope.
const composioInjection = (
    framework: AgentFramework,
    key: string
): McpInjection | undefined => {
    if (framework === 'codex') return { composioKey: key }
    if (isComposioJsonFramework(framework))
        return {
            servers: {
                [COMPOSIO_MCP_SERVER_NAME]: composioMcpServerJson(framework, key)
            }
        }
    return undefined
}

export const readFileText = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger: SpritesLogger
): Promise<string | null> => {
    const file = await spriteReadFile(client, spriteName, absPath, logger)
    if (!file) return null
    const chunks: Buffer[] = []
    for await (const chunk of file.stream) chunks.push(chunk)
    await file.done
    return Buffer.concat(chunks).toString('utf8')
}

export const spritesLoggerFrom = (log: Logger): SpritesLogger => ({
    debug: () => {},
    info: (m, meta) => log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) => log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
})
