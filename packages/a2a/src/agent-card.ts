import { guardedFetch, type UrlGuardOptions } from './url-guard'
import { A2aError, A2aErrorCode } from './errors'
import type { AgentCard, AgentInterface, A2aTransport } from './types'

export const WELL_KNOWN_AGENT_CARD_PATH = '/.well-known/agent-card.json'

export interface FetchAgentCardOptions extends UrlGuardOptions {
    bearer?: string
    signal?: AbortSignal
    supportedMajor?: number
}

export const resolveAgentCardUrl = (input: string): string => {
    let url: URL
    try {
        url = new URL(input.trim())
    } catch {
        throw new Error('agent card url must be a valid URL')
    }
    const path = url.pathname.replace(/\/+$/, '')
    const looksLikeCard = path.endsWith('.json')
    const looksLikeRpc = /\/(rpc|a2a)$/.test(path)
    if (looksLikeCard || looksLikeRpc) return url.toString()
    url.pathname = `${path}${WELL_KNOWN_AGENT_CARD_PATH}`
    return url.toString()
}

export const parseMajorVersion = (version: string): number => {
    const match = /^(\d+)(?:\.|$)/.exec(version.trim())
    return match ? Number(match[1]) : Number.NaN
}

export const assertSupportedProtocolVersion = (
    card: AgentCard,
    supportedMajor = 0
): void => {
    const major = parseMajorVersion(card.protocolVersion ?? '')
    if (!Number.isInteger(major) || major !== supportedMajor)
        throw new A2aError(
            A2aErrorCode.unsupportedOperation,
            `unsupported A2A protocolVersion '${card.protocolVersion}' (need major ${supportedMajor})`
        )
}

export const selectInterface = (
    card: AgentCard,
    transport: A2aTransport = 'JSONRPC'
): AgentInterface => {
    if (card.preferredTransport === transport && card.url)
        return { url: card.url, transport }
    for (const iface of card.additionalInterfaces ?? []) {
        if (iface.transport === transport && iface.url) return iface
    }
    throw new A2aError(
        A2aErrorCode.unsupportedOperation,
        `agent card exposes no ${transport} interface`
    )
}

export const fetchAgentCard = async (
    input: string,
    opts: FetchAgentCardOptions = {}
): Promise<AgentCard> => {
    const cardUrl = resolveAgentCardUrl(input)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
    const res = await guardedFetch(
        cardUrl,
        { method: 'GET', headers, signal: opts.signal },
        { allowPrivate: opts.allowPrivate, allowHttp: opts.allowHttp }
    )
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new A2aError(
            A2aErrorCode.invalidAgentResponse,
            `agent card fetch failed: ${res.status} ${text.slice(0, 200)}`
        )
    }
    let card: AgentCard
    try {
        card = (await res.json()) as AgentCard
    } catch {
        throw new A2aError(
            A2aErrorCode.invalidAgentResponse,
            'agent card response was not valid JSON'
        )
    }
    if (!card || typeof card.protocolVersion !== 'string' || !card.url)
        throw new A2aError(
            A2aErrorCode.invalidAgentResponse,
            'agent card missing required fields (protocolVersion, url)'
        )
    if (opts.supportedMajor !== undefined)
        assertSupportedProtocolVersion(card, opts.supportedMajor)
    return card
}
