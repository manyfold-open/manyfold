import { Logger } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { corsHeadersForOrigin } from '@/common/cors-headers'

const log = new Logger('FilesDownload')

export interface FileDownload {
    stream: AsyncIterable<Uint8Array | Buffer>
    // undefined when the transport cannot report a trustworthy length up front;
    // the response then falls back to chunked encoding instead of claiming a
    // Content-Length the body will not match
    size?: number
    contentType: string
    done?: Promise<void>
}

export interface DownloadTarget {
    agentId: string
    rootId: string
    path: string
    transport: string
}

const describe = (target: DownloadTarget): string =>
    `agent=${target.agentId} root=${target.rootId} transport=${target.transport} path=${target.path}`

export const streamFileToReply = async (
    reply: FastifyReply,
    download: FileDownload,
    target: DownloadTarget
): Promise<void> => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
        ...corsHeadersForOrigin(reply.request.headers),
        'content-type': download.contentType,
        ...(download.size === undefined
            ? {}
            : { 'content-length': String(download.size) }),
        'cache-control': 'no-store',
        'x-accel-buffering': 'no'
    })
    let sent = 0
    try {
        for await (const chunk of download.stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            sent += buf.byteLength
            if (!raw.write(buf)) {
                await new Promise<void>((resolve) =>
                    raw.once('drain', () => resolve())
                )
            }
        }
        if (download.done) await download.done
    } catch (err) {
        // the 200 already went out, so destroying the socket is the only failure
        // signal left: ending cleanly makes a truncated body look like a
        // complete download
        log.error(
            `download stream failed (${describe(target)}): ${(err as Error).message}`
        )
        raw.destroy()
        return
    }
    if (download.size !== undefined && sent !== download.size) {
        log.error(
            `download length mismatch (${describe(target)}): sent ${sent} of declared ${download.size}`
        )
        raw.destroy()
        return
    }
    raw.end()
}
