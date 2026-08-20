import { PayloadTooLargeException } from '@nestjs/common'

// A write body is either already in memory (chat attachments, small edits) or a
// request stream the API must not materialise. Adapters that can stream forward
// it; adapters that cannot collect it under their own cap.
export type FileWriteBody = Buffer | AsyncIterable<Uint8Array>

export interface UploadBound {
    maxBytes?: number
    rootId: string
    transport: string
}

const tooLarge = (bound: UploadBound, seen: number): PayloadTooLargeException =>
    new PayloadTooLargeException(
        `upload exceeds the ${bound.maxBytes}-byte limit of root "${bound.rootId}" (${bound.transport}) after ${seen} bytes`
    )

export const isStreamBody = (
    body: FileWriteBody
): body is AsyncIterable<Uint8Array> =>
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
    'function'

// Yields Buffers and fails as soon as the body outgrows the bound, so a client
// that lies about Content-Length cannot push more than the transport allows.
export const boundedChunks = (
    body: FileWriteBody,
    bound: UploadBound
): AsyncIterable<Buffer> => ({
    [Symbol.asyncIterator]: async function* () {
        const max = bound.maxBytes
        let seen = 0
        if (!isStreamBody(body)) {
            seen = body.byteLength
            if (max !== undefined && seen > max) throw tooLarge(bound, seen)
            yield body
            return
        }
        for await (const chunk of body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            seen += buf.byteLength
            if (max !== undefined && seen > max) throw tooLarge(bound, seen)
            yield buf
        }
    }
})

export const collectBounded = async (
    body: FileWriteBody,
    bound: UploadBound
): Promise<Buffer> => {
    if (!isStreamBody(body)) {
        if (bound.maxBytes !== undefined && body.byteLength > bound.maxBytes)
            throw tooLarge(bound, body.byteLength)
        return body
    }
    const parts: Buffer[] = []
    for await (const chunk of boundedChunks(body, bound)) parts.push(chunk)
    return Buffer.concat(parts)
}
