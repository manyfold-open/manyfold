import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { KubeConfig } from '@kubernetes/client-node'
import { execOnce, type GatewayExecRequestBody } from '@manyfold/k8s-exec-core'

const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')

const parseBody = (
    body: unknown,
    defaultTimeoutMs: number
): { ok: true; req: GatewayExecRequestBody } | { ok: false; reason: string } => {
    if (!body || typeof body !== 'object')
        return { ok: false, reason: 'body must be an object' }
    const b = body as Record<string, unknown>
    if (typeof b.namespace !== 'string' || b.namespace.length === 0)
        return { ok: false, reason: 'namespace must be a non-empty string' }
    if (typeof b.pod !== 'string' || b.pod.length === 0)
        return { ok: false, reason: 'pod must be a non-empty string' }
    if (typeof b.container !== 'string' || b.container.length === 0)
        return { ok: false, reason: 'container must be a non-empty string' }
    if (!isStringArray(b.cmd) || b.cmd.length === 0)
        return { ok: false, reason: 'cmd must be a non-empty string[]' }
    const stdin =
        typeof b.stdin === 'string' ? b.stdin : b.stdin === undefined ? undefined : null
    if (stdin === null)
        return { ok: false, reason: 'stdin must be a string when present' }
    const rawTimeout = typeof b.timeoutMs === 'number' ? b.timeoutMs : defaultTimeoutMs
    if (!Number.isFinite(rawTimeout) || rawTimeout <= 0)
        return { ok: false, reason: 'timeoutMs must be a positive number' }
    return {
        ok: true,
        req: {
            namespace: b.namespace,
            pod: b.pod,
            container: b.container,
            cmd: b.cmd,
            stdin,
            timeoutMs: rawTimeout
        }
    }
}

export const registerExecRoute = (
    app: FastifyInstance,
    kubeConfig: KubeConfig,
    opts: { defaultTimeoutMs: number }
): void => {
    app.post(
        '/exec',
        async (req: FastifyRequest, reply: FastifyReply) => {
            const parsed = parseBody(req.body, opts.defaultTimeoutMs)
            if (!parsed.ok) {
                await reply.code(400).send({
                    error: parsed.reason,
                    code: 'BAD_REQUEST'
                })
                return
            }
            const { namespace, pod, container, cmd, stdin, timeoutMs } = parsed.req
            const t0 = Date.now()
            try {
                const result = await execOnce(
                    kubeConfig,
                    { namespace, pod, container },
                    { cmd, stdin, timeoutMs }
                )
                await reply.code(200).send({
                    ...result,
                    durationMs: Date.now() - t0
                })
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                req.log.warn(
                    { ns: namespace, pod, container, cmd, durationMs: Date.now() - t0, err: message },
                    'pod exec failed'
                )
                if (message.includes('pod exec timed out')) {
                    await reply.code(504).send({
                        error: message,
                        code: 'TIMEOUT'
                    })
                    return
                }
                if (
                    message.includes('not found') ||
                    message.includes('no pod found')
                ) {
                    await reply.code(404).send({
                        error: message,
                        code: 'POD_NOT_FOUND'
                    })
                    return
                }
                await reply.code(502).send({
                    error: message,
                    code: 'UPSTREAM_FAILURE'
                })
            }
        }
    )
}
