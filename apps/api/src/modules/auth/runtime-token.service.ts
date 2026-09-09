import { createObjectId } from '@manyfold/shared'
import { randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
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

type RuntimeTokenTx = Parameters<Parameters<Database['transaction']>[0]>[0]

const RUNTIME_IDENTITY_LOCK_NAMESPACE = 7

export interface MintedRuntimeIdentity {
    runtimeTokenId: string
    plaintext: string
    agentId: string
    runtimeKind: RuntimeKind
}

export type RuntimeIdentityResult =
    | { created: false; plaintext: string }
    | (MintedRuntimeIdentity & { created: true })

@Injectable()
export class RuntimeTokenService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    // Mint (or rotate) the agent's identity token for one runtime kind. Identity
    // only — no scopes (authorization lives in agent_permissions, resolved per
    // request). Explicit mint always revokes an existing active row before
    // inserting a fresh one; ensureRuntimeIdentity is the read-through path
    // when callers need idempotent first-use behavior. The runtime credential
    // parent is written before the child so the Phase 3a cross-table trigger
    // sees kind='runtime'.
    async mintRuntimeIdentity(args: {
        userId: string
        agentId: string
        runtimeKind: RuntimeKind
        name?: string
    }): Promise<MintedRuntimeIdentity> {
        return this.db.transaction(async (tx) => {
            await this.lockRuntimeIdentity(tx, args)
            return this.mintRuntimeIdentityInTx(tx, args)
        })
    }

    // Ensure is the read-through path used by lazy runtime attachment. The
    // advisory lock must cover both the read and the possible mint: a unique
    // partial index prevents two active rows, but it cannot make the losing
    // request recover the plaintext that the winning request minted.
    async ensureRuntimeIdentity(args: {
        userId: string
        agentId: string
        runtimeKind: RuntimeKind
        name?: string
    }): Promise<RuntimeIdentityResult> {
        return this.db.transaction(async (tx) => {
            await this.lockRuntimeIdentity(tx, args)

            const [active] = await tx
                .select({
                    id: agentRuntimeTokens.id,
                    tokenCiphertext: agentRuntimeTokens.tokenCiphertext,
                    tokenKeyVersion: agentRuntimeTokens.tokenKeyVersion
                })
                .from(agentRuntimeTokens)
                .where(
                    and(
                        eq(agentRuntimeTokens.agentId, args.agentId),
                        eq(agentRuntimeTokens.runtimeKind, args.runtimeKind),
                        isNull(agentRuntimeTokens.revokedAt)
                    )
                )
                .limit(1)

            if (active?.tokenCiphertext && active.tokenKeyVersion !== null)
                return {
                    created: false,
                    plaintext: this.crypto.decrypt({
                        ciphertext: active.tokenCiphertext,
                        keyVersion: active.tokenKeyVersion
                    })
                }

            return {
                ...(await this.mintRuntimeIdentityInTx(tx, args)),
                created: true
            }
        })
    }

    // The read-through variant for a runtime that already HOLDS a copy of its
    // identity — a k8s pod, whose provisioning baked the plaintext into the
    // pod Secret. ensureRuntimeIdentity would rotate an active row it cannot
    // decrypt (a legacy row with no ciphertext), which revokes the very token
    // the pod is running on. So: an active row that decrypts is returned, an
    // active row that does not is left alone (null — the caller falls back to
    // whatever the runtime already holds), and only the absence of any active
    // row mints.
    async readOrMintRuntimeIdentity(args: {
        userId: string
        agentId: string
        runtimeKind: RuntimeKind
        name?: string
    }): Promise<string | null> {
        return this.db.transaction(async (tx) => {
            await this.lockRuntimeIdentity(tx, args)

            const [active] = await tx
                .select({
                    id: agentRuntimeTokens.id,
                    tokenCiphertext: agentRuntimeTokens.tokenCiphertext,
                    tokenKeyVersion: agentRuntimeTokens.tokenKeyVersion
                })
                .from(agentRuntimeTokens)
                .where(
                    and(
                        eq(agentRuntimeTokens.agentId, args.agentId),
                        eq(agentRuntimeTokens.runtimeKind, args.runtimeKind),
                        isNull(agentRuntimeTokens.revokedAt)
                    )
                )
                .limit(1)

            if (active) {
                if (active.tokenCiphertext && active.tokenKeyVersion !== null)
                    return this.crypto.decrypt({
                        ciphertext: active.tokenCiphertext,
                        keyVersion: active.tokenKeyVersion
                    })
                return null
            }
            return (await this.mintRuntimeIdentityInTx(tx, args)).plaintext
        })
    }

    private async lockRuntimeIdentity(
        tx: RuntimeTokenTx,
        args: { agentId: string; runtimeKind: RuntimeKind }
    ): Promise<void> {
        await tx.execute(
            sql`select pg_advisory_xact_lock(
                hashtextextended(${`${args.agentId}:${args.runtimeKind}`}, ${RUNTIME_IDENTITY_LOCK_NAMESPACE})
            )`
        )
    }

    private async mintRuntimeIdentityInTx(
        tx: RuntimeTokenTx,
        args: {
            userId: string
            agentId: string
            runtimeKind: RuntimeKind
            name?: string
        }
    ): Promise<MintedRuntimeIdentity> {
        const plaintext = `${RUNTIME_TOKEN_PREFIX}${randomBytes(
            TOKEN_BYTES
        ).toString('base64url')}`
        const tokenHash = hashApiToken(plaintext)
        // Encrypted copy so exec/terminal can inject this agent's identity at
        // run time (the plaintext is no longer persisted to the sprite profile).
        const enc = this.crypto.encrypt(plaintext)
        const runtimeTokenId = createObjectId('agentRuntimeToken')

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
        await tx.insert(tokenCredentials).values({ tokenHash, kind: 'runtime' })
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
