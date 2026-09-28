import { DEFAULT_CLI_API_URL, renderAgentSetupGuide } from '@manyfold/shared'
import { Controller, Get, Req, Res } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { CLI_INSTALL_URL, DEFAULT_WEB_BASE_URL } from '@/common/brand'
import { configString } from '@/common/config-alias'
import { cliChannelForDeployEnv, resolveMfDeployEnv } from '@/common/deploy-env'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'

// A bare host[:port]: nothing else from a request header may shape a URL the
// agent will send the user's credentials to.
const HOST_RE = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/

const httpUrl = (value: string | undefined): string | undefined => {
    if (!value) return undefined
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined
        if (url.username || url.password) return undefined
        return value.replace(/\/+$/, '')
    } catch {
        return undefined
    }
}

export const requestApiUrl = (
    host: string | undefined,
    proto: string | undefined
): string | undefined => {
    if (!host || !HOST_RE.test(host)) return undefined
    if (proto !== 'http' && proto !== 'https') return undefined
    return `${proto}://${host}/api`
}

const UNAVAILABLE_GUIDE = [
    '# Connect this agent to Manyfold',
    '',
    'This deployment cannot tell which address its API is published at, so it has no setup steps for you. Report that setup is not complete, and ask the user for their Manyfold API URL; the operator can fix this by setting `PUBLIC_API_BASE_URL`.',
    ''
].join('\n')

// Deliberately unauthenticated: the agent fetching this is not signed in yet —
// signing in is what the guide walks it through. It carries only what the
// deployment already publishes: its API and web URLs and its CLI channel.
@Controller()
export class AgentSetupController {
    constructor(private readonly config: ConfigService) {}

    @Get('agent-setup.md')
    async guide(
        @Req() req: FastifyRequest,
        @Res() reply: FastifyReply
    ): Promise<void> {
        await reply
            .header('content-type', 'text/markdown; charset=utf-8')
            .header('cache-control', 'no-store')
            .header('x-content-type-options', 'nosniff')
            .send(this.render(req))
    }

    private render(req: FastifyRequest): string {
        const forwardedProto = req.headers['x-forwarded-proto']
        const requestedVia = requestApiUrl(
            req.headers.host,
            (typeof forwardedProto === 'string'
                ? forwardedProto.split(',')[0]?.trim()
                : undefined) ?? req.protocol
        )
        // The configured public address wins: behind a reverse proxy the Host
        // header is often the upstream's own (127.0.0.1:2222), which a remote
        // agent cannot reach.
        const configured = configString(this.config, ['PUBLIC_API_BASE_URL'])
        const apiUrl = configured
            ? httpUrl(publicApiUrlWithApiPrefix(configured))
            : requestedVia
        if (!apiUrl) return UNAVAILABLE_GUIDE
        const webUrl =
            httpUrl(configString(this.config, ['MF_WEB_URL'])) ??
            (apiUrl === DEFAULT_CLI_API_URL ? DEFAULT_WEB_BASE_URL : undefined)
        return renderAgentSetupGuide({
            apiUrl,
            requestedVia,
            webUrl,
            cliChannel: cliChannelForDeployEnv(
                resolveMfDeployEnv(this.config.get<string>('MF_DEPLOY_ENV'))
            ),
            cliInstallUrl: CLI_INSTALL_URL
        })
    }
}
