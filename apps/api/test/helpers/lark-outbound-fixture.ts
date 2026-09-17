import { createServer } from 'node:http'
import { once } from 'node:events'
import { LarkChannelProvider } from '../../src/modules/channels/providers/lark.provider'

export const createLarkOutboundFixture = async (failure?: {
    status: number
    body: unknown
}) => {
    const uploads: Array<{
        kind: string
        fileType: string | null
        name: string
        bytes: string
    }> = []
    const messages: Array<{ path: string; body: Record<string, unknown> }> = []
    const errors: unknown[] = []
    const server = createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(Buffer.from(chunk))
            const bytes = Buffer.concat(chunks)
            res.setHeader('content-type', 'application/json')
            if (req.url?.endsWith('/tenant_access_token/internal')) {
                res.end(
                    JSON.stringify({
                        code: 0,
                        tenant_access_token: 'fixture-token',
                        expire: 7200
                    })
                )
            } else if (/\/(files|images)$/.test(req.url ?? '')) {
                const form = await new Response(bytes, {
                    headers: {
                        'content-type': String(req.headers['content-type'])
                    }
                }).formData()
                const image = req.url!.endsWith('/images')
                const file = form.get(image ? 'image' : 'file') as File
                uploads.push({
                    kind: image ? 'image' : 'file',
                    fileType: form.get('file_type') as string | null,
                    name: file.name,
                    bytes: await file.text()
                })
                res.end(
                    JSON.stringify({
                        code: 0,
                        data: image
                            ? { image_key: 'fixture-image' }
                            : { file_key: 'fixture-file' }
                    })
                )
            } else if (req.url?.startsWith('/open-apis/im/v1/messages')) {
                const body = JSON.parse(bytes.toString()) as Record<
                    string,
                    unknown
                >
                messages.push({ path: req.url, body })
                if (failure && body.msg_type !== 'text') {
                    res.statusCode = failure.status
                    res.end(JSON.stringify(failure.body))
                } else {
                    res.end(
                        JSON.stringify({
                            code: 0,
                            data: {
                                message_id: `fixture-message-${messages.length}`
                            }
                        })
                    )
                }
            } else
                throw new Error(
                    `Unexpected fixture route: ${req.method} ${req.url}`
                )
        })().catch((error) => {
            errors.push(error)
            res.statusCode = 500
            res.end(JSON.stringify({ code: -1 }))
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
        throw new Error('No fixture address')
    const provider = new LarkChannelProvider({ get: () => undefined } as never)
    // Only this fixture redirects the production HTTP path; no configurable
    // production endpoint or external Lark request is needed by these tests.
    ;(provider as unknown as { openBaseUrl: () => string }).openBaseUrl = () =>
        `http://127.0.0.1:${address.port}`
    return {
        provider,
        uploads,
        messages,
        errors,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()))
                server.closeAllConnections()
            })
        }
    }
}
