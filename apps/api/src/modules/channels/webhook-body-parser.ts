import { UnsupportedMediaTypeException } from '@nestjs/common'
import type { FastifyInstance } from 'fastify'

export const HOOKS_URL_PREFIX = '/api/channels/hooks/'
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

// Nest's Fastify adapter installs the form parser during app.init(). Registering
// another parser before init crashes startup with FST_ERR_CTP_ALREADY_PRESENT.
// Keep the parser Nest owns and reject form requests outside channel hooks before
// parsing so cookie-authenticated JSON routes retain the intended CSRF boundary.
export const registerChannelFormBodyGuard = (
    fastify: Pick<FastifyInstance, 'addHook'>
): void => {
    fastify.addHook('onRequest', (req, _reply, done) => {
        const contentType = req.headers['content-type']
            ?.split(';', 1)[0]
            ?.trim()
            .toLowerCase()
        const url = req.raw?.url ?? ''
        if (
            contentType === FORM_CONTENT_TYPE &&
            !url.startsWith(HOOKS_URL_PREFIX)
        ) {
            done(
                new UnsupportedMediaTypeException(
                    `unsupported content-type: ${FORM_CONTENT_TYPE}`
                )
            )
            return
        }
        done()
    })
}
