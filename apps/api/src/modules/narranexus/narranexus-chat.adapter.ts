import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage
} from '@manyfold/shared'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { OpenclawAdapter } from '@/modules/chat/adapters/openclaw.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import { manyfoldUserToNarraNexusUserId } from './narranexus-paths'

// NarraNexus surfaces resolver failures as a single content chunk prefixed
// with `[error] User '<user_id>' is missing the following slot bindings: [...]`
// (backend/routes/openai_compat.py). Rewriting that into an actionable hint
// keeps the chat UI from leaking an internal Python error and tells the user
// exactly where to go.
const SLOT_BINDING_ERROR_RE =
    /\[error\][^\n]*is missing the following slot bindings:\s*\[[^\]]+\][^\n]*/i

// With keep-alive default-off a cold wake now includes startService + run.sh
// boot, which is unmeasured — 2x the openclaw default, env-tunable so ops can
// adjust without a release.
const NARRANEXUS_PREFLIGHT_BUDGET_MS = Math.max(
    500,
    Number(process.env.NARRANEXUS_PREFLIGHT_BUDGET_MS ?? 60_000)
)

@Injectable()
export class NarraNexusChatAdapter extends OpenclawAdapter {
    readonly framework: AgentFramework = 'narranexus'
    private readonly nxDb: Database

    constructor(
        @Inject(DRIZZLE) db: Database,
        crypto: CryptoService,
        pricing: UsagePricingService,
        chatRepo: ChatRepository,
        drivers: ExecDriverFactory,
        telemetry: TelemetryService,
        @Optional() daemonRegistry?: DaemonRegistryService,
        @Optional() adminSettings?: AdminSettingsService
    ) {
        super(
            db,
            crypto,
            pricing,
            chatRepo,
            drivers,
            telemetry,
            daemonRegistry,
            adminSettings
        )
        this.nxDb = db
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

    protected override preflightBudgetMs(): number {
        return NARRANEXUS_PREFLIGHT_BUDGET_MS
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
        const [row] = await this.nxDb
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
