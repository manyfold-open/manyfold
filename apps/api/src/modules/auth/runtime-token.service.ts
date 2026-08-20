import { createObjectId } from '@manyfold/shared'
import { randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import {
    agentRuntimeTokens,
    tokenCredentials,
    type Database,
    type NewAgentRuntimeToken
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    RUNTIME_TOKEN_PREFIX,
    TOKEN_BYTES,
    hashApiToken
} from './api-token.service'

export type RuntimeKind = NonNullable<NewAgentRuntimeToken['runtimeKind']>

export interface MintedRuntimeIdentity {
    runtimeTokenId: string
    plaintext: string
    agentId: string
    runtimeKind: RuntimeKind
}

@Injectable()
export class RuntimeTokenService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    // Mint (or rotate) the agent's identity token for one runtime kind. Identity
    // only — no scopes (authorization lives in agent_permissions, resolved per
    // request). Idempotent per (agent, runtime_kind): any existing active row is
    // revoked first so the partial unique holds, and a fresh plaintext is
    // returned for injection. The runtime credential parent is written before
    // the child so the Phase 3a cross-table trigger sees kind='runtime'.
    async mintRuntimeIdentity(args: {
        userId: string
        agentId: string
        runtimeKind: RuntimeKind
        name?: string
    }): Promise<MintedRuntimeIdentity> {
        const plaintext = `${RUNTIME_TOKEN_PREFIX}${randomBytes(
            TOKEN_BYTES
        ).toString('base64url')}`
        const tokenHash = hashApiToken(plaintext)
        // Encrypted copy so exec/terminal can inject this agent's identity at
        // run time (the plaintext is no longer persisted to the sprite profile).
        const enc = this.crypto.encrypt(plaintext)
        const runtimeTokenId = createObjectId('agentRuntimeToken')

        await this.db.transaction(async (tx) => {
            await tx
                .update(agentRuntimeTokens)
                .set({ revokedAt: new Date() })
                .where(
                    and(
                        eq(agentRuntimeTokens.agentId, args.agentId),
                        eq(agentRuntimeTokens.runtimeKind, args.runtimeKind),
                        isNull(agentRuntimeTokens.revokedAt)
                    )
                )
            await tx
                .insert(tokenCredentials)
                .values({ tokenHash, kind: 'runtime' })
            await tx.insert(agentRuntimeTokens).values({
                id: runtimeTokenId,
                agentId: args.agentId,
                userId: args.userId,
                runtimeKind: args.runtimeKind,
                tokenHash,
                tokenCiphertext: enc.ciphertext,
                tokenKeyVersion: enc.keyVersion,
                name: args.name ?? `${args.runtimeKind} identity`
            })
        })

        return {
            runtimeTokenId,
            plaintext,
            agentId: args.agentId,
            runtimeKind: args.runtimeKind
        }
    }
}

// Fetch + decrypt an agent's active identity token for one runtime kind, for
// per-exec injection. Returns null for legacy tokens with no encrypted copy
// (those still rely on the plaintext baked into their sprite profile).
export const decryptActiveIdentityToken = async (
    db: Database,
    crypto: CryptoService,
    agentId: string,
    runtimeKind: RuntimeKind
): Promise<string | null> => {
    const [row] = await db
        .select({
            ciphertext: agentRuntimeTokens.tokenCiphertext,
            keyVersion: agentRuntimeTokens.tokenKeyVersion
        })
        .from(agentRuntimeTokens)
        .where(
            and(
                eq(agentRuntimeTokens.agentId, agentId),
                eq(agentRuntimeTokens.runtimeKind, runtimeKind),
                isNull(agentRuntimeTokens.revokedAt)
            )
        )
        .limit(1)
    if (!row?.ciphertext || row.keyVersion === null) return null
    return crypto.decrypt({
        ciphertext: row.ciphertext,
        keyVersion: row.keyVersion
    })
}
