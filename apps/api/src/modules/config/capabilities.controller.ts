import type { CapabilitiesResponse } from '@manyfold/shared'
import { Controller, Get, Header } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import { configString } from '@/common/config-alias'

// Deliberately unauthenticated (same posture as GET /auth/config): the web
// and admin apps read this before sign-in to decide which surfaces exist on
// this deployment. It reports presence/availability only — pricing, plans and
// entitlement stay behind their authenticated endpoints, and every gated
// action is still enforced server-side.
@Controller('config')
export class CapabilitiesController {
    constructor(
        private readonly registry: CapabilitiesRegistry,
        private readonly config: ConfigService
    ) {}

    @Get('capabilities')
    @Header('Cache-Control', 'public, max-age=30')
    async capabilities(): Promise<CapabilitiesResponse> {
        return {
            // Informational only, derived from what this composition root
            // wired — never an authorization input.
            edition: this.registry.has('billing') ? 'cloud' : 'self-hosted',
            features: await this.registry.snapshot(),
            branding: {
                name: 'Manyfold',
                webBaseUrl:
                    configString(this.config, ['MF_WEB_URL', 'NCA_WEB_URL']) ??
                    'https://manyfold.ai'
            }
        }
    }
}
