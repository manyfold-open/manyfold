import { codingAgentWorkspacePath } from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import {
    createClient,
    SpritesError,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import type { Agent, AgentRuntimeRow } from '@manyfold/db'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import {
    assertWorkspaceUsableOnSprite,
    isAgentWorkspaceManaged,
    resolveWorkspaceSelection
} from '@/modules/agents/workspace/workspace-preflight'

export type MkdirFn = (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger?: SpritesLogger
) => Promise<void>

export type RmFn = (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    opts?: { recursive?: boolean },
    logger?: SpritesLogger
) => Promise<void>

export type CreateClientFn = typeof createClient

@Injectable()
export class SpritesAgentAttacher {
    private readonly log = new Logger(SpritesAgentAttacher.name)

    constructor(
        private readonly accounts: SpritesAccountsService,
        private readonly mkdir: MkdirFn,
        private readonly rm: RmFn,
        private readonly createSpritesClient: CreateClientFn
    ) {}

    async attach(args: {
        runtime: AgentRuntimeRow
        agentId: string
        workspace?: string
    }): Promise<{ workspacePath: string; internalId: string }> {
        if (!args.runtime.spriteName)
            throw new Error(
                `runtime ${args.runtime.id} has no spriteName; cannot attach`
            )
        const client = await this.clientFor(args.runtime)
        const selection = resolveWorkspaceSelection(
            args.workspace,
            codingAgentWorkspacePath('sprites', args.agentId)
        )
        if (selection.managed)
            await this.mkdir(client, args.runtime.spriteName, selection.path)
        else
            await assertWorkspaceUsableOnSprite({
                client,
                spriteName: args.runtime.spriteName,
                workspacePath: selection.path,
                logger: spritesLogger(this.log)
            })
        return { workspacePath: selection.path, internalId: args.agentId }
    }

    async detach(args: {
        runtime: AgentRuntimeRow
        agent: Agent
    }): Promise<void> {
        if (!args.runtime.spriteName) return
        if (!args.agent.workspacePath) return
        if (!isAgentWorkspaceManaged(args.agent)) return
        try {
            const client = await this.clientFor(args.runtime)
            await this.rm(
                client,
                args.runtime.spriteName,
                args.agent.workspacePath,
                { recursive: true }
            )
        } catch (err) {
            if (isNotFound(err)) return
            throw err
        }
    }

    private async clientFor(runtime: AgentRuntimeRow): Promise<SpritesClient> {
        if (!runtime.accountId)
            throw new Error(
                `runtime ${runtime.id} has no accountId; cannot resolve sprites client`
            )
        const account = await this.accounts.getById(runtime.accountId)
        if (!account)
            throw new Error(
                `sprites account ${runtime.accountId} not found for runtime ${runtime.id}`
            )
        const token = this.accounts.decryptToken(account)
        return this.createSpritesClient({
            token,
            accountSlug: account.slug,
            logger: spritesLogger(this.log)
        })
    }
}

const isNotFound = (err: unknown): boolean => {
    if (err instanceof SpritesError && err.code === 'not_found') return true
    if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code?: string }).code
        return code === 'not_found'
    }
    return false
}

const spritesLogger = (log: Logger): SpritesLogger => ({
    debug: (m: string, meta?: Record<string, unknown>) =>
        log.debug?.(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    info: (m: string, meta?: Record<string, unknown>) =>
        log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m: string, meta?: Record<string, unknown>) =>
        log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m: string, meta?: Record<string, unknown>) =>
        log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
})
