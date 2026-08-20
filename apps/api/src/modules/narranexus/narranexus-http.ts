import { agentBaseUrl } from '@manyfold/shared'
import { eq } from 'drizzle-orm'
import { agentCredentials, type Database } from '@manyfold/db'
import type { CryptoService } from '@/modules/secrets/crypto.service'

export const NARRANEXUS_DEFAULT_TIMEOUT_MS = 10_000
export const NARRANEXUS_LIST_TIMEOUT_MS = 5_000

export const loadNarraNexusGatewayToken = async (
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
        const parsed = JSON.parse(plain) as { gatewayToken?: string }
        return parsed.gatewayToken ?? null
    } catch {
        return null
    }
}

export interface NarraNexusFetchOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    timeoutMs?: number
    body?: unknown
}

export interface NarraNexusFetchResult {
    status: number
    ok: boolean
    text: string
    json: <T>() => T
}

export const narraNexusFetch = async (
    ingressHost: string,
    path: string,
    token: string,
    options: NarraNexusFetchOptions = {}
): Promise<NarraNexusFetchResult> => {
    const {
        method = 'GET',
        timeoutMs = NARRANEXUS_DEFAULT_TIMEOUT_MS,
        body
    } = options
    const url = agentBaseUrl(ingressHost, path)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
        const resp = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body !== undefined
                    ? { 'Content-Type': 'application/json' }
                    : {})
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: ac.signal
        })
        const text = await resp.text().catch(() => '')
        return {
            status: resp.status,
            ok: resp.ok,
            text,
            json: <T>() => JSON.parse(text) as T
        }
    } finally {
        clearTimeout(timer)
    }
}
