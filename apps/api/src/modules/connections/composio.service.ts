import type { ComposioToolSummary } from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'

// Composio Connect is consumed as an MCP server, not a REST API — the consumer
// key is sent as the `x-consumer-api-key` header. There's no documented verify
// endpoint, so we probe the MCP endpoint with a JSON-RPC `initialize` handshake
// and treat an explicit auth rejection (401/403) as an invalid key. Anything
// else (incl. protocol/transport quirks) is accepted so a good key is never
// false-rejected; a network error fails closed.
export const COMPOSIO_MCP_URL = 'https://connect.composio.dev/mcp'
export const COMPOSIO_API_KEY_HEADER = 'x-consumer-api-key'
// Reserved managed MCP server name injected for a linked Composio connection —
// a user-defined server of the same name is overridden by the managed one.
export const COMPOSIO_MCP_SERVER_NAME = 'composio'

const INITIALIZE_BODY = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'manyfold', version: '1.0.0' }
    }
})

const SESSION_HEADER = 'mcp-session-id'

interface McpToolPayload {
    name?: string
    description?: string
}

interface JsonRpcMessage {
    id?: unknown
    result?: unknown
    error?: { message?: string }
}

@Injectable()
export class ComposioService {
    private readonly log = new Logger(ComposioService.name)

    async verifyKey(apiKey: string): Promise<{ valid: boolean }> {
        try {
            const res = await fetch(COMPOSIO_MCP_URL, {
                method: 'POST',
                headers: this.headers(apiKey),
                body: INITIALIZE_BODY,
                signal: AbortSignal.timeout(15_000)
            })
            return { valid: res.status !== 401 && res.status !== 403 }
        } catch (err) {
            this.log.warn(`composio verify failed: ${(err as Error).message}`)
            return { valid: false }
        }
    }

    // The tools the Connect MCP server currently exposes for this consumer key
    // (i.e. what a linked agent actually gets), via a fresh streamable-HTTP
    // handshake: initialize → notifications/initialized → tools/list.
    async listTools(apiKey: string): Promise<ComposioToolSummary[]> {
        const init = await this.post(apiKey, INITIALIZE_BODY)
        if (init.message?.error)
            throw new Error(
                init.message.error.message ?? 'composio initialize failed'
            )
        // The spec requires this notification before other calls; some servers
        // don't, so a failure here is non-fatal.
        await this.post(
            apiKey,
            JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            }),
            init.sessionId
        ).catch(() => undefined)
        const listed = await this.post(
            apiKey,
            JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            }),
            init.sessionId
        )
        if (listed.message?.error)
            throw new Error(
                listed.message.error.message ?? 'composio tools/list failed'
            )
        const tools =
            (listed.message?.result as { tools?: McpToolPayload[] } | undefined)
                ?.tools ?? []
        return tools
            .filter((tool): tool is McpToolPayload & { name: string } =>
                Boolean(tool.name)
            )
            .map((tool) => ({
                name: tool.name,
                description: tool.description ?? null
            }))
    }

    private async post(
        apiKey: string,
        body: string,
        sessionId?: string
    ): Promise<{ message: JsonRpcMessage | null; sessionId?: string }> {
        const headers = this.headers(apiKey)
        if (sessionId) headers[SESSION_HEADER] = sessionId
        const res = await fetch(COMPOSIO_MCP_URL, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(15_000)
        })
        if (res.status === 401 || res.status === 403)
            throw new Error('composio rejected the Connect API key')
        const nextSession =
            res.headers.get(SESSION_HEADER) ?? sessionId ?? undefined
        const text = await res.text()
        if (!res.ok)
            throw new Error(
                `composio mcp call failed: ${res.status} ${text.slice(0, 200)}`
            )
        return { message: this.parseMessage(text), sessionId: nextSession }
    }

    // Streamable-HTTP responses are either a plain JSON-RPC body or an SSE
    // stream whose `data:` events each carry one JSON-RPC message — take the
    // last one with a result/error (earlier events can be progress noise).
    private parseMessage(text: string): JsonRpcMessage | null {
        const trimmed = text.trim()
        if (!trimmed) return null
        if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
            try {
                return JSON.parse(trimmed) as JsonRpcMessage
            } catch {
                return null
            }
        }
        let last: JsonRpcMessage | null = null
        for (const line of trimmed.split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
                const message = JSON.parse(
                    line.slice(5).trim()
                ) as JsonRpcMessage
                if (message.result !== undefined || message.error) last = message
            } catch {
                continue
            }
        }
        return last
    }

    private headers(apiKey: string): Record<string, string> {
        return {
            [COMPOSIO_API_KEY_HEADER]: apiKey,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        }
    }
}
