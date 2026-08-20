import { SpritesError, classifyHttpStatus } from './errors'
import type { SpritesClient } from './client'
import type { SpritesLogger } from './types'

const DEFAULT_TIMEOUT_MS = 10 * 60_000

export interface SpriteFsReadResult {
    stream: AsyncIterable<Uint8Array>
    size: number | null
    contentType: string
}

export interface SpriteFsWriteArgs {
    absPath: string
    body: AsyncIterable<Uint8Array> | Buffer
    mode?: string
    timeoutMs?: number
}

export const spriteFsReadFile = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger?: SpritesLogger,
    timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SpriteFsReadResult | null> => {
    const url = fsUrl(client, spriteName, 'read', {
        path: absPath,
        workingDir: '/'
    })
    const res = await fsFetch(client, url, { method: 'GET', timeoutMs })
    if (res.status === 404) return null
    if (!res.ok || !res.body)
        await throwForStatus(res, 'read', spriteName, absPath)
    logger?.debug('sprites.fs.read', { spriteName, absPath })
    return {
        stream: res.body as unknown as AsyncIterable<Uint8Array>,
        size: parseContentLength(res.headers.get('content-length')),
        contentType:
            res.headers.get('content-type') ?? 'application/octet-stream'
    }
}

export const spriteFsWriteFile = async (
    client: SpritesClient,
    spriteName: string,
    args: SpriteFsWriteArgs,
    logger?: SpritesLogger
): Promise<void> => {
    const url = fsUrl(client, spriteName, 'write', {
        path: args.absPath,
        workingDir: '/',
        mode: args.mode ?? '0600',
        mkdir: 'true'
    })
    const body = Buffer.isBuffer(args.body)
        ? new Uint8Array(args.body)
        : (args.body as AsyncIterable<Uint8Array>)
    const init: FsFetchInit = {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as unknown as BodyInit,
        duplex: 'half' as const,
        timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS
    }
    const res = await fsFetch(client, url, init)
    if (!res.ok) await throwForStatus(res, 'write', spriteName, args.absPath)
    logger?.debug('sprites.fs.write', {
        spriteName,
        absPath: args.absPath
    })
}

const fsUrl = (
    client: SpritesClient,
    spriteName: string,
    op: string,
    query: Record<string, string>
): string => {
    const params = new URLSearchParams(query)
    return `${client.baseUrl}/sprites/${encodeURIComponent(spriteName)}/fs/${op}?${params.toString()}`
}

type FsFetchInit = RequestInit & {
    timeoutMs: number
    duplex?: 'half'
}

const fsFetch = async (
    client: SpritesClient,
    url: string,
    init: FsFetchInit
): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs)
    try {
        const headers = new Headers(init.headers)
        const auth = client.authHeaderForInternalUse()
        headers.set('authorization', auth.Authorization)
        return await fetch(url, {
            ...init,
            headers,
            signal: controller.signal
        } as RequestInit & { duplex?: 'half' })
    } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError'
        throw new SpritesError(
            'transient',
            isAbort
                ? `sprites.dev fs request timed out after ${init.timeoutMs}ms`
                : `sprites.dev fs network error: ${(err as Error).message}`
        )
    } finally {
        clearTimeout(timer)
    }
}

const throwForStatus = async (
    res: Response,
    op: string,
    spriteName: string,
    absPath: string
): Promise<never> => {
    const body = await res.text().catch(() => '')
    throw new SpritesError(
        classifyHttpStatus(res.status),
        `sprites.dev fs ${op} ${spriteName}:${absPath} -> ${res.status}`,
        res.status,
        body
    )
}

const parseContentLength = (value: string | null): number | null => {
    if (!value) return null
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
}
