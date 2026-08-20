import Fastify from 'fastify'
import { KubeConfig } from '@kubernetes/client-node'
import { loadConfig } from './config'
import { makeBearerAuth } from './auth'
import { registerExecRoute } from './exec.handler'

const main = async (): Promise<void> => {
    const config = loadConfig()
    const kubeConfig = new KubeConfig()
    if (process.env.KUBECONFIG) kubeConfig.loadFromFile(process.env.KUBECONFIG)
    else kubeConfig.loadFromCluster()

    const app = Fastify({
        logger: {
            level: process.env.LOG_LEVEL ?? 'info'
        },
        bodyLimit: config.maxBodyBytes,
        trustProxy: true
    })

    app.get('/healthz', async () => ({ ok: true }))

    const requireAuth = makeBearerAuth(config.tokens)
    app.addHook('preHandler', async (req, reply) => {
        if (req.url === '/healthz') return
        await requireAuth(req, reply)
    })

    registerExecRoute(app, kubeConfig, {
        defaultTimeoutMs: config.defaultExecTimeoutMs
    })

    app.setErrorHandler(async (err: Error, req, reply) => {
        req.log.error({ err }, 'unhandled error')
        if (!reply.sent)
            await reply.code(500).send({
                error: err.message,
                code: 'INTERNAL'
            })
    })

    const close = async (): Promise<void> => {
        try {
            await app.close()
        } finally {
            process.exit(0)
        }
    }
    process.on('SIGTERM', () => void close())
    process.on('SIGINT', () => void close())

    await app.listen({ port: config.port, host: config.host })
    app.log.info(
        {
            port: config.port,
            host: config.host,
            tokens: config.tokens.size,
            kubeContext: kubeConfig.getCurrentContext()
        },
        'manyfold-k8s-gateway ready'
    )
}

void main().catch((err) => {
    console.error('fatal:', err)
    process.exit(1)
})
