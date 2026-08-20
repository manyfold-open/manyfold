import { and, eq, isNull } from 'drizzle-orm'
import { userConnections, type Database } from '@manyfold/db'
import type { CryptoService } from '@/modules/secrets/crypto.service'

// Decrypt the Composio consumer key for a linked connection, or null when the
// binding is empty / revoked / missing. Pure helper (no NestJS): both the MCP
// materializer and the Codex credential-apply path already hold `db` + `crypto`,
// so injecting it this way keeps them free of a ConnectionsService dependency
// (which would close a module cycle with the fan-out edge).
export const decryptComposioKey = async (
    db: Database,
    crypto: CryptoService,
    userId: string,
    connectionId: string | null | undefined
): Promise<string | null> => {
    if (!connectionId) return null
    const [row] = await db
        .select()
        .from(userConnections)
        .where(
            and(
                eq(userConnections.id, connectionId),
                eq(userConnections.userId, userId),
                eq(userConnections.provider, 'composio'),
                isNull(userConnections.revokedAt)
            )
        )
        .limit(1)
    if (!row?.secretCiphertext) return null
    return crypto.decrypt({
        ciphertext: row.secretCiphertext,
        keyVersion: row.keyVersion
    })
}
