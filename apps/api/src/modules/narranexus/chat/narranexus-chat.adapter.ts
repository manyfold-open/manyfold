import type {
    AgentFramework,
    ChatAttachmentBlock,
    ChatCapabilities,
    ChatMessage
} from '@manyfold/shared'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agentCredentials, agents, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from '@/modules/chat/adapters/daemon-fenced-dispatch.service'
import {
    GatewayHttpChatAdapter,
    type OpenclawRuntime
} from '@/modules/chat/adapters/gateway-http-chat.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import { NARRANEXUS_PORT } from '../bootstrap/narranexus-k8s'
import {
    manyfoldProviderToNarraNexusChannelProvider,
    manyfoldUserToNarraNexusUserId
} from '../narranexus-paths'

// NarraNexus surfaces resolver failures as a single content chunk prefixed
// with `[error] User '<user_id>' is missing the following slot bindings: [...]`
// (backend/routes/openai_compat.py). Rewriting that into an actionable hint
// keeps the chat UI from leaking an internal Python error and tells the user
// exactly where to go.
const SLOT_BINDING_ERROR_RE =
    /\[error\][^\n]*is missing the following slot bindings:\s*\[[^\]]+\][^\n]*/i

@Injectable()
export class NarraNexusChatAdapter extends GatewayHttpChatAdapter {
    readonly framework: AgentFramework = 'narranexus'

    constructor(
        @Inject(DRIZZLE) db: Database,
        crypto: CryptoService,
        pricing: UsagePricingService,
        chatRepo: ChatRepository,
        drivers: ExecDriverFactory,
        telemetry: TelemetryService,
        @Optional() daemonRegistry?: DaemonRegistryService,
        @Optional() adminSettings?: AdminSettingsService,
        // No @Optional, unlike the base: boot must fail when this module
        // cannot see the service, rather than dispatch without the #619
        // generation fence.
        fencedDispatch?: DaemonFencedDispatchService
    ) {
        super(
            db,
            crypto,
            pricing,
            chatRepo,
            drivers,
            telemetry,
            daemonRegistry,
            adminSettings,
            fencedDispatch
        )
    }

    getCapabilities(): ChatCapabilities {
        return {
            streaming: true,
            toolCalls: true,
            thinking: true,
            // False when this adapter was written, because the gateway had no
            // write endpoint yet. Chat attachment ingest has landed files in
            // the NarraNexus workspace since #504, and the shared table — the
            // gate that ingest and the composer actually read — has said true
            // throughout.
            attachments: true,
            multiTurn: true
        }
    }

    // NarraNexus's /v1/chat/completions accepts channel_provider +
    // channel_context and flips the turn from owner-chat into channel mode:
    // the agent then delivers its own reply through its local channel tools
    // (backend/routes/manyfold_sync.py).
    //
    // Everything past the four base keys is optional on the wire: NarraNexus
    // reads what a given provider's reply command needs (context_token for
    // wechat_send, thread_id for threaded replies, chat_type/is_mention for
    // group etiquette and silent memory ingest) and ignores the rest.
    protected channelBodyFields(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): Record<string, unknown> {
        const src = ctx.channelSource
        if (!src) return {}
        const channelProvider = manyfoldProviderToNarraNexusChannelProvider(
            src.provider,
            { mirrored: src.mirrored === true }
        )
        if (!channelProvider) return {}
        const attachments = userMessage.contentBlocks
            .filter((b): b is ChatAttachmentBlock => b.type === 'attachment')
            .map((b) => ({
                name: b.name,
                mime: b.contentType,
                size: b.size,
                path: b.path
            }))
        return {
            channel_provider: channelProvider,
            channel_context: {
                room_id: src.chatId,
                sender_id: src.senderId,
                sender_name: src.senderName ?? null,
                source_message_id: src.messageId ?? null,
                chat_type: src.chatType,
                ...(src.threadId ? { thread_id: src.threadId } : {}),
                ...(src.isMention !== undefined
                    ? { is_mention: src.isMention }
                    : {}),
                ...(src.replyToken ? { reply_token: src.replyToken } : {}),
                ...(attachments.length > 0 ? { attachments } : {})
            }
        }
    }

    protected async resolveRuntime(agentId: string): Promise<OpenclawRuntime> {
        const [agent] = await this.db
            .select({
                ingressHost: agents.ingressHost,
                runtimeId: agents.runtimeId,
                internalId: agents.internalId,
                name: agents.name
            })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) throw new Error(`agent ${agentId} not found`)
        if (!agent.runtimeId)
            throw new Error(`agent ${agentId} has no linked runtime`)
        const [credRow] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, agent.runtimeId))
            .limit(1)
        if (!credRow)
            throw new Error(`no stored credentials for agent ${agentId}`)
        const creds = JSON.parse(
            this.crypto.decrypt({
                ciphertext: credRow.payloadCiphertext,
                keyVersion: credRow.keyVersion
            })
        ) as { gatewayToken?: string }
        if (!creds.gatewayToken)
            throw new Error(
                `agent ${agentId} narranexus runtime missing gatewayToken — rebuild the runtime`
            )
        return {
            ingressHost: agent.ingressHost ?? '',
            gatewayToken: creds.gatewayToken,
            modelId: agent.internalId,
            displayModel: agent.name,
            port: NARRANEXUS_PORT
        }
    }

    async *sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        let setupHint: string | null = null
        for await (const ev of super.sendMessage(ctx, userMessage)) {
            if (ev.type === 'token' && SLOT_BINDING_ERROR_RE.test(ev.text)) {
                if (setupHint === null)
                    setupHint = await this.buildSetupHint(ctx.agentId)
                yield { type: 'token', text: setupHint }
                continue
            }
            yield ev
        }
    }

    private async buildSetupHint(agentId: string): Promise<string> {
        const [row] = await this.db
            .select({
                ingressHost: agents.ingressHost,
                userId: agents.userId
            })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!row?.ingressHost || !row.userId)
            // Fail loud — better to say something than emit an empty hint.
            return (
                '\n⚠️ NarraNexus provider setup required, but the dashboard ' +
                'URL or user id could not be resolved for this agent. ' +
                'Contact an administrator.\n'
            )
        const dashboardUrl = `https://${row.ingressHost}/`
        const loginUserId = manyfoldUserToNarraNexusUserId(row.userId)
        return [
            '',
            '⚠️ NarraNexus provider setup required for this agent.',
            '',
            `Dashboard: ${dashboardUrl}`,
            `Login user_id: \`${loginUserId}\` (local mode — no password)`,
            '',
            'In **Settings → Providers**, bind these three slots, then retry:',
            '- `agent` — Claude-compatible (Anthropic)',
            '- `embedding` — OpenAI-compatible embeddings',
            '- `helper_llm` — OpenAI-compatible chat',
            ''
        ].join('\n')
    }
}
