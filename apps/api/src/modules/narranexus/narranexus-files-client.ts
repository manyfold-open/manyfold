import { agentBaseUrl } from '@manyfold/shared'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { FsEntry } from '@manyfold/sprites'
import { narraNexusFetch } from './narranexus-http'

interface NarraNexusListEntry {
    name: string
    type?: 'file' | 'dir' | 'link'
    size?: number
    mtime?: number
    mode?: string
}

interface NarraNexusListResponse {
    entries: NarraNexusListEntry[]
}

interface NarraNexusStatResponse {
    entry: NarraNexusListEntry
}

interface NarraNexusRootsResponse {
    roots: Array<{
        id: string
        label: string
        path: string
        writable?: boolean
        supportsListing?: boolean
    }>
}

const toEntry = (e: NarraNexusListEntry): FsEntry => ({
    name: e.name,
    type: e.type === 'dir' ? 'dir' : 'file',
    size: e.size ?? 0,
    mtime: e.mtime ?? 0,
    mode: e.mode ?? '644'
})

export interface NarraNexusFilesTarget {
    ingressHost: string
    gatewayToken: string
    agentId: string
}

const NARRANEXUS_WRITE_TIMEOUT_MS = 60_000

export const narraNexusListRoots = async (
    t: NarraNexusFilesTarget
): Promise<NarraNexusRootsResponse['roots']> => {
    const res = await narraNexusFetch(
        t.ingressHost,
        `/manyfold/agents/${encodeURIComponent(t.agentId)}/files/roots`,
        t.gatewayToken
    )
    if (!res.ok)
        throw new Error(
            `narranexus files/roots failed (status ${res.status})`
        )
    return res.json<NarraNexusRootsResponse>().roots ?? []
}

export const narraNexusListDir = async (
    t: NarraNexusFilesTarget,
    absPath: string
): Promise<FsEntry[]> => {
    const res = await narraNexusFetch(
        t.ingressHost,
        `/manyfold/agents/${encodeURIComponent(t.agentId)}/files/list?path=${encodeURIComponent(absPath)}`,
        t.gatewayToken
    )
    if (res.status === 403) throw new ForbiddenException(res.text)
    if (res.status === 404) throw new NotFoundException(res.text)
    if (!res.ok)
        throw new Error(
            `narranexus files/list failed (status ${res.status})`
        )
    return (res.json<NarraNexusListResponse>().entries ?? []).map(toEntry)
}

export const narraNexusStat = async (
    t: NarraNexusFilesTarget,
    absPath: string
): Promise<{ entry: FsEntry; contentType: string } | null> => {
    const res = await narraNexusFetch(
        t.ingressHost,
        `/manyfold/agents/${encodeURIComponent(t.agentId)}/files/stat?path=${encodeURIComponent(absPath)}`,
        t.gatewayToken
    )
    if (res.status === 404) return null
    if (res.status === 403) throw new ForbiddenException(res.text)
    if (!res.ok)
        throw new Error(
            `narranexus files/stat failed (status ${res.status})`
        )
    const entry = toEntry(res.json<NarraNexusStatResponse>().entry)
    return { entry, contentType: 'application/octet-stream' }
}

export const narraNexusRead = async (
    t: NarraNexusFilesTarget,
    absPath: string
): Promise<{
    stream: AsyncIterable<Uint8Array | Buffer>
    size?: number
    contentType: string
} | null> => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 60_000)
    const url = agentBaseUrl(
        t.ingressHost,
        `/manyfold/agents/${encodeURIComponent(t.agentId)}/files/read?path=${encodeURIComponent(absPath)}`
    )
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${t.gatewayToken}` },
        signal: ac.signal
    })
    if (resp.status === 404) {
        clearTimeout(timer)
        return null
    }
    if (resp.status === 403) {
        clearTimeout(timer)
        throw new ForbiddenException(await resp.text().catch(() => ''))
    }
    if (resp.status === 413) {
        clearTimeout(timer)
        throw new ForbiddenException(
            `narranexus refused: file exceeds 64MiB preview limit`
        )
    }
    if (!resp.ok || !resp.body) {
        clearTimeout(timer)
        throw new Error(
            `narranexus files/read failed (status ${resp.status})`
        )
    }
    // a missing header means unknown, not empty — reporting 0 would put a
    // Content-Length: 0 in front of a real body
    const rawLength = resp.headers.get('content-length')
    const parsed = rawLength === null ? Number.NaN : Number(rawLength)
    const size = Number.isFinite(parsed) ? parsed : undefined
    const contentType =
        resp.headers.get('content-type') ?? 'application/octet-stream'
    const stream = streamFromResponse(resp.body, timer)
    return { stream, size, contentType }
}

// The gateway's only write entrypoint. It creates parent directories itself,
// so there is no mkdir to pair with this. overwrite defaults to false upstream;
// chat ingest writes into a fresh uuid directory but may retry the same path,
// so it asks for true to stay idempotent.
export const narraNexusWrite = async (
    t: NarraNexusFilesTarget,
    absPath: string,
    body: Buffer | AsyncIterable<Uint8Array>,
    opts: { overwrite?: boolean } = {}
): Promise<void> => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), NARRANEXUS_WRITE_TIMEOUT_MS)
    const url = agentBaseUrl(
        t.ingressHost,
        `/manyfold/agents/${encodeURIComponent(t.agentId)}/files/write?path=${encodeURIComponent(absPath)}&overwrite=${opts.overwrite === true}`
    )
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${t.gatewayToken}`,
                'content-type': 'application/octet-stream'
            },
            body: body as unknown as BodyInit,
            signal: ac.signal,
            duplex: 'half'
        } as RequestInit & { duplex: 'half' })
        if (resp.status === 403)
            throw new ForbiddenException(await resp.text().catch(() => ''))
        if (resp.status === 404)
            throw new NotFoundException(await resp.text().catch(() => ''))
        if (!resp.ok)
            throw new Error(
                `narranexus files/write failed (status ${resp.status})`
            )
    } finally {
        clearTimeout(timer)
    }
}

const streamFromResponse = (
    body: ReadableStream<Uint8Array>,
    timer: NodeJS.Timeout
): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: () => {
        const reader = body.getReader()
        return {
            next: async () => {
                const { value, done } = await reader.read()
                if (done) {
                    clearTimeout(timer)
                    return { value: undefined, done: true }
                }
                return { value, done: false }
            },
            return: async () => {
                clearTimeout(timer)
                await reader.cancel().catch(() => {})
                return { value: undefined, done: true }
            }
        }
    }
})
