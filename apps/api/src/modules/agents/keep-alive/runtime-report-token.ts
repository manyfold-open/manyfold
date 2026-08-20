import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { agentCredentials, type Database } from '@manyfold/db'
import type { CryptoService } from '@/modules/secrets/crypto.service'
import { mergeGeneratedCredentials } from '@/modules/agents/credentials/credential-merge'

// No brand prefix: internal-only value that matches the sibling generated
// credentials sharing the same encrypted payload (gatewayToken/apiServerKey,
// all randomBytes(32).hex).
export const generateRuntimeReportToken = (): string =>
    randomBytes(32).toString('hex')

export const loadRuntimeReportToken = async (
    db: Database,
    crypto: CryptoService,
    runtimeId: string
): Promise<string | null> => {
    const [row] = await db
        .select()
        .from(agentCredentials)
        .where(eq(agentCredentials.runtimeId, runtimeId))
        .limit(1)
    if (!row) return null
    try {
        const plain = crypto.decrypt({
            ciphertext: row.payloadCiphertext,
            keyVersion: row.keyVersion
        })
        const parsed = JSON.parse(plain) as { runtimeReportToken?: string }
        return parsed.runtimeReportToken ?? null
    } catch {
        return null
    }
}

export const ensureRuntimeReportToken = async (
    db: Database,
    crypto: CryptoService,
    runtimeId: string
): Promise<string | null> => {
    try {
        let token: string | null = null
        // NEVER insert here: row creation belongs to the provisioning
        // orchestrator, and inserting would race an in-flight provision. A
        // missing row just means the reporter is not installed this round.
        const merged = await mergeGeneratedCredentials(
            db,
            crypto,
            runtimeId,
            (current) => {
                const existing = current.runtimeReportToken
                if (typeof existing === 'string' && existing.length > 0) {
                    token = existing
                    return null
                }
                token = generateRuntimeReportToken()
                return { ...current, runtimeReportToken: token }
            }
        )
        if (!merged) return null
        return token
    } catch {
        return null
    }
}
