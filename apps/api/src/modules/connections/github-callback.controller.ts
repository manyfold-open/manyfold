import { Controller, Get, Logger, Query, Res } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyReply } from 'fastify'
import { configString } from '@/common/config-alias'
import { ConnectionsService } from '@/modules/connections/connections.service'
import { DEFAULT_WEB_BASE_URL } from '@/common/brand'

// Public (no guard): GitHub redirects the user's browser here after install.
// userId is recovered from the signed `state`, not a session.
@Controller('connections/github')
export class GithubCallbackController {
    private readonly log = new Logger(GithubCallbackController.name)

    constructor(
        private readonly service: ConnectionsService,
        private readonly config: ConfigService
    ) {}

    @Get('callback')
    async callback(
        @Query('installation_id') installationId: string | undefined,
        @Query('state') state: string | undefined,
        @Query('setup_action') setupAction: string | undefined,
        @Res() reply: FastifyReply
    ): Promise<void> {
        const settings = `${this.webUrl()}/connections`
        this.log.log(
            `github callback: installation_id=${Boolean(installationId)} state=${Boolean(state)} setup_action=${setupAction ?? 'none'}`
        )
        try {
            if (!installationId || !state)
                throw new Error('missing installation_id or state')
            await this.service.completeGithubCallback({ installationId, state })
            await reply.redirect(`${settings}?connected=github`, 302)
        } catch (err) {
            const reason = err instanceof Error ? err.message : 'unknown'
            this.log.warn(`github connection callback failed: ${reason}`)
            await reply.redirect(
                `${settings}?error=github&reason=${encodeURIComponent(
                    reason.slice(0, 200)
                )}`,
                302
            )
        }
    }

    private webUrl(): string {
        return (
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? DEFAULT_WEB_BASE_URL
        ).replace(/\/+$/, '')
    }
}
