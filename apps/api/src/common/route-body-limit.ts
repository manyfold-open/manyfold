import type { FastifyInstance } from 'fastify'

// Nest's @RouteConfig({ bodyLimit }) lands in the route's `config`, which the
// body parser never reads, so every JSON route stayed at Fastify's 1 MiB.
// Copy it to the route option the parser does read.
export const applyRouteBodyLimits = (fastify: FastifyInstance): void => {
    fastify.addHook('onRoute', (route) => {
        const limit = (route.config as { bodyLimit?: unknown } | undefined)
            ?.bodyLimit
        if (typeof limit === 'number' && route.bodyLimit === undefined)
            route.bodyLimit = limit
    })
}
