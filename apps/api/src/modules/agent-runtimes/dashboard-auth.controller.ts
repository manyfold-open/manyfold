import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Header,
    HttpCode,
    InternalServerErrorException,
    Param,
    Post,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { configString } from '@/common/config-alias'
import { K8sRuntimeSidecarService } from './orchestration/k8s-runtime-sidecar.service'

interface DashboardTicketBody {
    rd: string
}

// Cookie TTL for the apex-scoped `mf_dashboard` cookie. Long enough that
// a user can sit on the dashboard for an hour without an auth-url 401 →
// bounce-to-signin loop. The bearer token's own TTL still applies
// inside; the dashboard-auth-check endpoint re-verifies on every nginx
// auth subrequest.
const DASHBOARD_COOKIE_MAX_AGE_SECONDS = 3600

@Controller('agent-runtimes')
export class AgentRuntimesDashboardAuthController {
    constructor(
        private readonly sidecar: K8sRuntimeSidecarService,
        private readonly config: ConfigService
    ) {}

    // The Domain attribute on the apex cookie. Must be the shared parent of
    // the API host AND every `agent-<id>-dashboard.*` host so the ingress
    // auth-url subrequest sees the cookie. Configured per-deployment because
    // staging / self-hosted environments live on a different apex than prod.
    private requireCookieDomain(): string {
        const explicit = configString(this.config, [
            'MF_DASHBOARD_COOKIE_DOMAIN',
            'NCA_DASHBOARD_COOKIE_DOMAIN'
        ])
        if (explicit) return explicit
        const authUrl = configString(this.config, [
            'MF_AUTH_URL',
            'NCA_AUTH_URL'
        ])
        if (authUrl) {
            try {
                const host = new URL(authUrl).hostname
                if (host) return `.${host.replace(/^\.+/, '')}`
            } catch {
                /* fall through */
            }
        }
        throw new InternalServerErrorException(
            'MF_DASHBOARD_COOKIE_DOMAIN not set and could not be derived from MF_AUTH_URL'
        )
    }

    @Get(':id/dashboard-auth-check')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    async check(
        @Param('id') id: string,
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply
    ): Promise<void> {
        const cookie = (req.headers['cookie'] as string | undefined) ?? ''
        const ok = await this.sidecar.checkDashboardAuth(cookie, id)
        if (ok) {
            await res.code(200).send()
        } else {
            await res.code(401).send()
        }
    }

    // Mints an apex-scoped session cookie (`mf_dashboard`) so the user's
    // already-validated bearer token can be read by the dashboard
    // subdomain ingress's auth-url subrequest. Sidesteps cross-subdomain
    // cookie scoping quirks (host-only cookies etc.) — the value is just the
    // same bearer token, but planted on the apex with a 5-minute Max-Age.
    @Post('dashboard-ticket')
    @HttpCode(204)
    @UseGuards(AuthGuard)
    async dashboardTicket(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: DashboardTicketBody,
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply
    ): Promise<void> {
        const rd = typeof body?.rd === 'string' ? body.rd : ''
        if (!rd)
            throw new BadRequestException(
                'rd (dashboard URL) is required in body'
            )
        const runtime = await this.sidecar.resolveOwnedDashboardRuntime(
            rd,
            user.userId
        )
        if (!runtime)
            throw new ForbiddenException('not authorized for this dashboard')
        const authHeader =
            (req.headers['authorization'] as string | undefined) ?? ''
        const bearer = authHeader.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length).trim()
            : ''
        if (!bearer)
            throw new BadRequestException(
                'bearer token required (cannot mint cookie without source token)'
            )
        const cookie = [
            `mf_dashboard=${encodeURIComponent(bearer)}`,
            `Domain=${this.requireCookieDomain()}`,
            'Path=/',
            'Secure',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${DASHBOARD_COOKIE_MAX_AGE_SECONDS}`
        ].join('; ')
        await res.header('Set-Cookie', cookie).code(204).send()
    }
}
