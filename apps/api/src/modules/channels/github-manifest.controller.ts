import { Controller, Get, Logger, Query, Res } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyReply } from 'fastify'
import { configString } from '@/common/config-alias'
import { ChannelsService } from './channels.service'
import { DEFAULT_WEB_BASE_URL } from '@/common/brand'

// Public (no guard): GitHub redirects the user's browser here after creating
// the app from our manifest. The channel and owner are recovered from the
// signed `state`, not a session.
@Controller('channels/github')
export class GithubManifestCallbackController {
    private readonly log = new Logger(GithubManifestCallbackController.name)

    constructor(
        private readonly channels: ChannelsService,
        private readonly config: ConfigService
    ) {}

    @Get('manifest-callback')
    async callback(
        @Query('code') code: string | undefined,
        @Query('state') state: string | undefined,
        @Res() reply: FastifyReply
    ): Promise<void> {
        const settings = `${this.webUrl()}/settings/channels`
        this.log.log(
            `github manifest callback: code=${Boolean(code)} state=${Boolean(state)}`
        )
        try {
            if (!code || !state) throw new Error('missing code or state')
            const { channelId } = await this.channels.completeGithubManifest({
                code,
                state
            })
            await reply.redirect(
                `${settings}/${channelId}?github=created`,
                302
            )
        } catch (err) {
            const reason = err instanceof Error ? err.message : 'unknown'
            this.log.warn(`github manifest callback failed: ${reason}`)
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
