import { eq } from 'drizzle-orm'
import { agentCredentials, type Database } from '@manyfold/db'
import type { CryptoService } from '@/modules/secrets/crypto.service'

// Serialized read-modify-write on a runtime's encrypted credential payload.
// Every generated-field writer (runtimeReportToken, dashboardToken) and any
// future merge MUST go through this row lock: the payload is a single
// ciphertext blob, so two unlocked decrypt→merge→encrypt writers silently
// drop each other's fields.
export const mergeGeneratedCredentials = async (
    db: Database,
    crypto: CryptoService,
    runtimeId: string,
    merge: (
        current: Record<string, unknown>
    ) => Record<string, unknown> | null
): Promise<Record<string, unknown> | null> =>
    db.transaction(async (tx) => {
        const [row] = await tx
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, runtimeId))
            .limit(1)
            .for('update')
        if (!row) return null
        const parsed = JSON.parse(
            crypto.decrypt({
                ciphertext: row.payloadCiphertext,
                keyVersion: row.keyVersion
            })
        ) as Record<string, unknown>
        const next = merge(parsed)
        if (next === null) return parsed
        const encrypted = crypto.encrypt(JSON.stringify(next))
        await tx
            .update(agentCredentials)
            .set({
                payloadCiphertext: encrypted.ciphertext,
                keyVersion: encrypted.keyVersion,
                updatedAt: new Date()
            })
            .where(eq(agentCredentials.runtimeId, runtimeId))
        return next
    })
