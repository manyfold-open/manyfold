import type { AgentFramework } from '@manyfold/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { AgentRuntimeRow, Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    NotSupportedError,
    type AddAgentContext,
    type AddAgentResult,
    type AgentAdapter,
    type AgentAdapterContext,
    type AgentAdapterCreateResult,
    type AgentAdapterListContext,
    type FrameworkAgent,
    type RemoveAgentContext,
    type UpdateAgentContext
} from '@/modules/agents/adapters/agent-adapter'
import {
    loadNarraNexusGatewayToken,
    narraNexusFetch,
    NARRANEXUS_LIST_TIMEOUT_MS
} from './narranexus-http'
import {
    manyfoldUserToNarraNexusUserId,
    narraNexusSeedWorkspacePath
} from './narranexus-paths'
import { narraNexusListRoots } from './narranexus-files-client'

interface NarraNexusAgentRow {
    agent_id: string
    name?: string | null
    description?: string | null
    agent_type?: string | null
    created_by?: string | null
    is_public?: boolean | null
}

interface NarraNexusListResponse {
    object?: string
    data?: NarraNexusAgentRow[]
}

interface NarraNexusCreateResponse {
    agent_id: string
    user_id?: string
    user_created?: boolean
    agent_created?: boolean
}

interface NarraNexusPatchResponse {
    agent_id: string
    name?: string
    description?: string
    updated_fields?: string[]
}

@Injectable()
export class NarraNexusAgentAdapter implements AgentAdapter {
    readonly framework: AgentFramework = 'narranexus'
    private readonly log = new Logger(NarraNexusAgentAdapter.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    // Provisioning-time seed: the NarraNexus agent does not exist yet, so
    // files/roots has nothing to answer. FilesContextBuilder replaces this with
    // the gateway's own path the first time the workspace is touched.
    async createAgent(
        ctx: AgentAdapterContext
    ): Promise<AgentAdapterCreateResult> {
        return {
            workspacePath: narraNexusSeedWorkspacePath(
                ctx.runtime.kind,
                ctx.agentId,
                ctx.runtime.userId
            )
        }
    }

    async deleteAgent(): Promise<void> {}

    async listAgents(ctx: AgentAdapterListContext): Promise<FrameworkAgent[]> {
        const { runtime } = ctx
        if (!runtime.ingressHost)
            throw new Error(
                `narranexus listAgents: runtime ${runtime.id} has no ingress host`
            )
        const token = await this.requireToken(runtime)
        const res = await narraNexusFetch(
            runtime.ingressHost,
            '/manyfold/agents',
            token,
            { timeoutMs: NARRANEXUS_LIST_TIMEOUT_MS }
        )
        if (!res.ok)
            throw new Error(
                `narranexus listAgents failed (status ${res.status}): ${truncate(res.text)}`
            )
        const parsed = res.json<NarraNexusListResponse>()
        if (!Array.isArray(parsed.data))
            throw new Error(
                `narranexus listAgents: unexpected response shape: ${truncate(res.text)}`
            )
        const rows = parsed.data
        return rows
            .filter((r) => typeof r.agent_id === 'string')
            .map(
                (r): FrameworkAgent => ({
                    id: r.agent_id,
                    name: r.name ?? r.agent_id,
                    // /manyfold/agents does not report a working path, and
                    // deriving one here is what produced the stale-layout bug:
                    // reconcile keeps whatever the row already has, and the
                    // files context backfills the resolved path. One roots call
                    // per listed agent per round is not worth the accuracy —
                    // if NarraNexus ever adds the field, read it here instead.
                    workspace: null,
                    model: null,
                    extras: {
                        description: r.description ?? null,
                        agentType: r.agent_type ?? null,
                        createdBy: r.created_by ?? null,
                        isPublic: r.is_public ?? null
                    }
                })
            )
    }

    async addAgent(ctx: AddAgentContext): Promise<AddAgentResult> {
        const { runtime, internalId, name } = ctx
        if (!runtime.ingressHost)
            throw new Error(`runtime ${runtime.id} has no ingress host`)
        const token = await this.requireToken(runtime)
        const mfUserId = manyfoldUserToNarraNexusUserId(runtime.userId)
        const body = {
            agent_id: internalId,
            agent_name: name,
            manyfold_user_id: runtime.userId
        }
        const res = await narraNexusFetch(
            runtime.ingressHost,
            '/manyfold/agents',
            token,
            { method: 'POST', body }
        )
        if (!res.ok)
            throw new Error(
                `narranexus addAgent failed (status ${res.status}): ${truncate(res.text)}`
            )
        const parsed = res.json<NarraNexusCreateResponse>()
        return {
            internalId: parsed.agent_id,
            // The agent exists now, so the gateway can name its workspace —
            // one call on a rare operation, and the row starts out correct.
            // null on failure, not a guess: the files context resolves it.
            workspace: await this.workspaceFromGateway(
                runtime,
                parsed.agent_id,
                token
            ),
            model: null,
            extras: {
                narraNexusUserId: parsed.user_id ?? mfUserId,
                userCreated: parsed.user_created ?? false,
                agentCreated: parsed.agent_created ?? false
            }
        }
    }

    async removeAgent(ctx: RemoveAgentContext): Promise<void> {
        const { runtime, agent } = ctx
        if (!runtime.ingressHost) return
        const token = await loadNarraNexusGatewayToken(
            this.db,
            this.crypto,
            runtime.id
        )
        if (!token) {
            this.log.warn(
                `narranexus removeAgent: no gateway token for runtime ${runtime.id} — skipping container DELETE`
            )
            return
        }
        const res = await narraNexusFetch(
            runtime.ingressHost,
            `/manyfold/agents/${encodeURIComponent(agent.internalId)}`,
            token,
            { method: 'DELETE' }
        )
        if (res.ok) return
        if (res.status === 404) return
        throw new Error(
            `narranexus removeAgent failed (status ${res.status}): ${truncate(res.text)}`
        )
    }

    async updateAgent(ctx: UpdateAgentContext): Promise<void> {
        const { runtime, agent, patch } = ctx
        if (!patch.name && !patch.description) return
        if (!runtime.ingressHost) return
        const token = await this.requireToken(runtime)
        const body: Record<string, string> = {}
        if (patch.name !== undefined) body.agent_name = patch.name
        if (patch.description !== undefined)
            body.agent_description = patch.description
        const res = await narraNexusFetch(
            runtime.ingressHost,
            `/manyfold/agents/${encodeURIComponent(agent.internalId)}`,
            token,
            { method: 'PATCH', body }
        )
        if (res.ok) {
            const parsed = res.json<NarraNexusPatchResponse>()
            this.log.debug?.(
                `narranexus updateAgent ${agent.internalId} updated fields=${(parsed.updated_fields ?? []).join(',')}`
            )
            return
        }
        if (res.status === 404)
            throw new NotSupportedError(this.framework, 'updateAgent: 404')
        throw new Error(
            `narranexus updateAgent failed (status ${res.status}): ${truncate(res.text)}`
        )
    }

    private async workspaceFromGateway(
        runtime: AgentRuntimeRow,
        agentId: string,
        token: string
    ): Promise<string | null> {
        if (!runtime.ingressHost) return null
        try {
            const roots = await narraNexusListRoots({
                ingressHost: runtime.ingressHost,
                gatewayToken: token,
                agentId
            })
            const workspace =
                roots.find((r) => r.id === 'workspace') ?? roots[0]
            return workspace?.path?.trim() || null
        } catch (err) {
            this.log.warn(
                `narranexus files/roots failed for new agent ${agentId}: ${(err as Error).message}`
            )
            return null
        }
    }

    private async requireToken(runtime: AgentRuntimeRow): Promise<string> {
        const token = await loadNarraNexusGatewayToken(
            this.db,
            this.crypto,
            runtime.id
        )
        if (!token)
            throw new Error(
                `narranexus runtime ${runtime.id} missing gateway token in agent_credentials`
            )
        return token
    }
}

const truncate = (s: string): string =>
    s.length > 256 ? `${s.slice(0, 256)}…` : s
