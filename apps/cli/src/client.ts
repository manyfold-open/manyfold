import type { NcaClient } from '@manyfold/sdk'
import { DEFAULT_API_URL } from '@/channel'
import { loadConfig } from '@/config'
import { resolveSecretInput } from '@/secret-input'
import { createCliClient } from '@/transport'

export { DEFAULT_API_URL }

export interface ClientContext {
    apiUrl: string
    token?: string
}

export const buildClient = async (opts: {
    apiUrl?: string
    token?: string
    account?: boolean
}): Promise<{ client: NcaClient; ctx: ClientContext }> => {
    const stored = await loadConfig()
    const apiUrl = opts.apiUrl ?? stored.apiUrl ?? DEFAULT_API_URL
    // MF_API_TOKEN is the platform-injected agent identity (sprite shell-env /
    // k8s Secret). It sits below an explicit --token (opts.token) so a human
    // override still wins.
    const envToken = process.env.MF_API_TOKEN?.trim() || undefined
    const token = resolveSecretInput(opts.token) ?? envToken ?? stored.token
    const client = createCliClient({
        baseUrl: apiUrl,
        token,
        accountScope: opts.account
    })
    return { client, ctx: { apiUrl, token } }
}

const MISSING_SCOPE_RE = /agent permission missing scope: one of \[(.+?)\]/

// When an `--account` command is denied for a missing permission, reuse the
// request-permission flow to resolve the owner-consent URL (ADR-0010). Best
// effort: it never throws, and returns undefined when it cannot help. The
// caller decides how to surface it (human hint vs JSON error field).
export const resolveAccountScopeDenial = async (
    message: string,
    opts: {
        account?: boolean
        agentId?: string
        apiUrl?: string
        token?: string
    }
): Promise<{ scopes: string[]; consentUrl?: string } | undefined> => {
    if (!opts.account) return undefined
    const match = MISSING_SCOPE_RE.exec(message)
    if (!match) return undefined
    const scopes = match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    const agentId = opts.agentId ?? process.env.MF_AGENT_ID?.trim()
    if (!agentId || scopes.length === 0) return undefined
    try {
        const { client } = await buildClient(opts)
        const res = await client.agents.requestPermission(agentId, {
            scopes
        } as never)
        return { scopes, consentUrl: res.consentUrl }
    } catch {
        return { scopes }
    }
}

