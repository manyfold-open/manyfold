import {
    AgentFramework,
    AgentSummary,
    envTextFromExtras
} from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    type Database
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import type { BootstrapContext } from '@/modules/agents/bootstrap/framework-bootstrap'
import type { SpriteServiceBootstrap } from '@/modules/agents/bootstrap/sprite-framework-bootstrap'
import { HermesSpriteBootstrap } from '@/modules/agents/bootstrap/hermes-sprite'
import { OpenClawSpriteBootstrap } from '@/modules/agents/bootstrap/openclaw-sprite'
import { NarraNexusSpriteBootstrap } from '@/modules/agents/bootstrap/narranexus-sprite'

// Restarting a framework's long-lived sprite service to pick up edited
// environment variables. Sprite env only propagates via delete→upsert→start
// (SpritesClient.upsertService caveat), so each bootstrap's `restart` re-runs
// that dance with the freshly merged env — no reinstall. Coding agents have no
// service (their env applies per-exec), so they 400 here.
@Injectable()
export class AgentServiceRestartService {
    private readonly log = new Logger(AgentServiceRestartService.name)
    private readonly serviceBootstraps: ReadonlyMap<
        AgentFramework,
        SpriteServiceBootstrap
    >

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly agents: AgentsService,
        private readonly crypto: CryptoService,
        hermesSpriteBootstrap: HermesSpriteBootstrap,
        openclawSpriteBootstrap: OpenClawSpriteBootstrap,
        narraNexusSpriteBootstrap: NarraNexusSpriteBootstrap
    ) {
        this.serviceBootstraps = new Map<
            AgentFramework,
            SpriteServiceBootstrap
        >([
            ['hermes', hermesSpriteBootstrap],
            ['openclaw', openclawSpriteBootstrap],
            ['narranexus', narraNexusSpriteBootstrap]
        ])
    }

    async restart(
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
        const bootstrap = this.serviceBootstraps.get(agent.framework)
        if (!bootstrap)
            throw new BadRequestException(
                `${agent.framework} agents don't run a restartable service; environment variables apply on the next command`
            )
        if (agent.runtime !== 'sprites')
            throw new BadRequestException(
                'service restart is only supported on sprite runtimes'
            )
        if (!agent.runtimeId)
            throw new BadRequestException('agent has no runtime')
        if (!agent.accountId || !agent.spriteName)
            throw new BadRequestException('agent has no sprite')

        const creds = await this.decryptCreds(agent.runtimeId)
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new Error(`sprites account ${agent.accountId} not found`)
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
        const [runtimeRow] = await this.db
            .select({
                controlUiEnabled: agentRuntimes.controlUiEnabled,
                dashboardEnabled: agentRuntimes.dashboardEnabled
            })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, agent.runtimeId))
            .limit(1)
        const ctx: BootstrapContext = {
            agentId: agent.id,
            runtimeId: agent.runtimeId,
            userId: agent.userId,
            spriteName: agent.spriteName,
            mountPath: agent.mountPath,
            client,
            logger: this.spritesLogger(),
            envText: envTextFromExtras(agent.extras) ?? null,
            controlUiEnabled: runtimeRow?.controlUiEnabled,
            dashboardEnabled: runtimeRow?.dashboardEnabled
        }
        this.log.log(
            `restarting ${agent.framework} service for agent ${agent.id} to apply env`
        )
        await bootstrap.restart(ctx, creds)
        // The process that carried the old env is gone, so record when this one
        // came up: it is how anything holding "saved but not yet applied" state
        // (the web's environment pending-restart mark) learns the values are
        // live, no matter which surface triggered the restart.
        const startedAt = new Date()
        await this.db
            .update(agents)
            .set({ startedAt, updatedAt: startedAt })
            .where(eq(agents.id, agentId))
        return this.agents.get(agentId, callerUserId, isAdmin)
    }

    private async decryptCreds(runtimeId: string): Promise<unknown> {
        const [row] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, runtimeId))
            .limit(1)
        if (!row)
            throw new Error(`no stored credentials for runtime ${runtimeId}`)
        return JSON.parse(
            this.crypto.decrypt({
                ciphertext: row.payloadCiphertext,
                keyVersion: row.keyVersion
            })
        )
    }

    private spritesLogger(): SpritesLogger {
        return {
            debug: () => {},
            info: (m, meta) =>
                this.log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            warn: (m, meta) =>
                this.log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            error: (m, meta) =>
                this.log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
        }
    }
}