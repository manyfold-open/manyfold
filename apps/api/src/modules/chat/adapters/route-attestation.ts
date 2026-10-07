import { DAEMON_FEATURE_TURN_ROUTE_ATTESTATION } from '@manyfold/shared'
import type { Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    userModelProviders,
    type Database,
    type UserModelProviderRow
} from '@manyfold/db'
import type { CryptoService } from '@/modules/secrets/crypto.service'
import type { ChatRepository } from '@/modules/chat/chat.repository'
import {
    daemonAdvertisesFeature,
    type ApiChatAdapterContext
} from '@/modules/chat/chat-adapter'
import {
    UNKNOWN_PRICE_SCOPE,
    attestedPriceScope,
    createRouteNonce,
    routeReceiptFor,
    routeReceiptFromMetadata,
    type RouteReceipt,
    type ServedPriceScope
} from '@/modules/usage/served-price-scope'

// The route attestation of a framework whose runtime picks its provider from
// its own config (OpenClaw, Hermes): the binding at dispatch is only what the
// API expects, never what it prices by. Without a daemon that can answer, the
// turn prices with no provider scope from the start. Pricing never fails a
// turn: a lookup that breaks reads as no receipt, and says so.
export const beginRouteAttestation = async (
    deps: {
        db: Database
        crypto: CryptoService
        chatRepo: ChatRepository
        logger: Logger
    },
    ctx: ApiChatAdapterContext,
    daemonId: string
): Promise<RouteReceipt | null> => {
    let supported = false
    try {
        supported = await daemonAdvertisesFeature(
            deps.db,
            daemonId,
            DAEMON_FEATURE_TURN_ROUTE_ATTESTATION
        )
    } catch (err) {
        deps.logger.warn(
            `route attestation capability lookup failed messageId=${ctx.messageId}: ${(err as Error).message}`
        )
    }
    if (!supported) {
        await ctx.onServedPriceScope?.({ ...UNKNOWN_PRICE_SCOPE })
        return null
    }
    const nonce = createRouteNonce()
    let provider: UserModelProviderRow | null = null
    let providerApiKey: string | null = null
    if (ctx.modelProviderId) {
        try {
            const [row] = await deps.db
                .select()
                .from(userModelProviders)
                .where(eq(userModelProviders.id, ctx.modelProviderId))
                .limit(1)
            if (row && row.userId === ctx.userId) {
                provider = row
                providerApiKey = deps.crypto.decrypt({
                    ciphertext: row.apiKeyCiphertext,
                    keyVersion: row.keyVersion
                })
            }
        } catch (err) {
            deps.logger.warn(
                `route attestation provider read failed messageId=${ctx.messageId}: ${(err as Error).message}`
            )
            provider = null
            providerApiKey = null
        }
    }
    const receipt = routeReceiptFor({ nonce, provider, providerApiKey })
    await deps.chatRepo.stampTurnRouteReceipt(
        ctx.messageId,
        ctx.sessionId,
        receipt,
        ctx.turnFence
    )
    return receipt
}

// The scope a turn's usage is priced with, from the daemon's answer in its
// final checked against the dispatch receipt: the live one, or the stamped
// one when this is a replay after the API that dispatched it is gone.
export const settleRouteAttestation = async (
    deps: { chatRepo: ChatRepository; logger: Logger },
    ctx: ApiChatAdapterContext,
    final: Record<string, unknown> | undefined,
    live?: RouteReceipt | null
): Promise<ServedPriceScope> => {
    let receipt: RouteReceipt | null = live ?? null
    if (live === undefined)
        try {
            receipt = routeReceiptFromMetadata(
                (await deps.chatRepo.getMessageById(ctx.messageId))
                    ?.capabilityEventsJson
            )
        } catch (err) {
            deps.logger.warn(
                `route receipt read failed messageId=${ctx.messageId}: ${(err as Error).message}`
            )
        }
    const { scope, outcome } = attestedPriceScope(
        receipt,
        final?.['routeAttestation']
    )
    if (outcome !== 'verified') {
        const status = final?.['routeAttestationStatus']
        const line = `route attestation ${outcome} framework=${ctx.framework} messageId=${ctx.messageId}${typeof status === 'string' ? ` status=${status}` : ''}; priced with no provider scope`
        if (outcome === 'mismatch') deps.logger.warn(line)
        else deps.logger.log(line)
    }
    await ctx.onServedPriceScope?.(scope)
    return scope
}
