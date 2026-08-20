import type { FastifyReply, FastifyRequest } from 'fastify'

const PREFIX = 'Bearer '

export const makeBearerAuth =
    (tokens: Set<string>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const header = req.headers['authorization']
        if (typeof header !== 'string' || !header.startsWith(PREFIX)) {
            await reply.code(401).send({
                error: 'missing bearer token',
                code: 'UNAUTHORIZED'
            })
            return
        }
        const presented = header.slice(PREFIX.length).trim()
        if (!tokens.has(presented)) {
            await reply.code(401).send({
                error: 'invalid bearer token',
                code: 'UNAUTHORIZED'
            })
            return
        }
    }
