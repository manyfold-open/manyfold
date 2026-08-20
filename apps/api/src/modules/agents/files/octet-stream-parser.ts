import type { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'

// Hands routes the raw request stream for application/octet-stream instead of a
// fully buffered body: file uploads used to be materialised here in full, so peak
// memory tracked file size. Size limits are enforced while the body is consumed,
// per file root, because the real caps differ by transport.
export const registerOctetStreamParser = (fastify: FastifyInstance): void => {
    fastify.addContentTypeParser(
        'application/octet-stream',
        (
            _req: unknown,
            payload: Readable,
            done: (err: Error | null, body?: Readable) => void
        ) => {
            done(null, payload)
        }
    )
}
