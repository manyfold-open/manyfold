import {
    AgentSummary,
    isVersionedFramework,
    parseProbedSemver
} from '@manyfold/shared'
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    type Agent,
    type AgentRuntimeRow,
    type Database
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    execSprite,
    type SpritesClient
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'

const PROBE_TIMEOUT_MS = 30_000

@Injectable()
export class FrameworkVersionProbeService {
    private readonly log = new Logger(FrameworkVersionProbeService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly agents: AgentsService
    ) {}

    // Probe + persist the installed framework version for an agent, then return
    // the refreshed summary. Ownership is enforced via AgentsService.
    async refresh(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        await this.probeAndPersist(agent)
        return this.agents.get(agentId, callerUserId, isAdmin)
    }

    // Sprite-only. No-op for non-versioned frameworks or non-sprite runtimes.
    // A probe that cannot run leaves the stored version untouched (never
    // clobbers a known-good value with null).
    async probeAndPersist(agent: Agent): Promise<string | null> {
        if (!isVersionedFramework(agent.framework) || !agent.runtimeId)
            return null
        const runtime = await this.loadRuntime(agent.runtimeId)
        if (!runtime || runtime.kind !== 'sprites') return null
        const spriteName = agent.spriteName ?? runtime.spriteName
        if (!spriteName) return null

        const descriptor = frameworkVersionDescriptor(agent.framework)
        let parsed: string | null = null
        try {
            const client = await this.spriteClientFor(agent, runtime)
            const result = await execSprite(client, spriteName, {
                cmd: ['bash', '-lc', descriptor.probeShell],
                stdin: '',
                timeoutMs: PROBE_TIMEOUT_MS
            })
            parsed = parseProbedSemver(`${result.stdout}\n${result.stderr}`)
        } catch (err) {
            this.log.warn(
                `framework-version probe failed for agent ${agent.id}: ${(err as Error).message}`
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
            .where(eq(agentRuntimes.id, runtime.id))
        return parsed
    }

    private async loadRuntime(
        runtimeId: string
    ): Promise<AgentRuntimeRow | null> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        return row ?? null
    }

    private async spriteClientFor(
        agent: Agent,
        runtime: AgentRuntimeRow
    ): Promise<SpritesClient> {
        const accountId = agent.accountId ?? runtime.accountId
        if (!accountId)
            throw new Error(`sprites agent ${agent.id} missing accountId`)
        const account = await this.accounts.getById(accountId)
        if (!account) throw new Error(`sprites account ${accountId} not found`)
        return createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
    }
}
