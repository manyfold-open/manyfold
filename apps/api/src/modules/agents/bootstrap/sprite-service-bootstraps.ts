import { SPRITE_HOME_BASE, type AgentFramework } from '@manyfold/shared'
import { Injectable, Optional } from '@nestjs/common'
import type { SpriteServiceBootstrap } from '@/modules/agents/bootstrap/sprite-framework-bootstrap'
import { HermesSpriteBootstrap } from '@/modules/agents/bootstrap/hermes-sprite'
import { OpenClawSpriteBootstrap } from '@/modules/agents/bootstrap/openclaw-sprite'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'

const HERMES_HOME = `${SPRITE_HOME_BASE}/.hermes`
const OPENCLAW_WORKSPACE = `${SPRITE_HOME_BASE}/.openclaw/workspace`

// The sprite service of every service-kind framework: the core ones, then
// whatever a framework module registered (ADR-0034). Each answer is undefined
// for a framework that runs no service on a sprite.
@Injectable()
export class SpriteServiceBootstraps {
    constructor(
        private readonly hermes: HermesSpriteBootstrap,
        private readonly openclaw: OpenClawSpriteBootstrap,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry()
    ) {}

    get(framework: AgentFramework): SpriteServiceBootstrap | undefined {
        if (framework === 'hermes') return this.hermes
        if (framework === 'openclaw') return this.openclaw
        return this.extensions.get(framework)?.spriteService?.bootstrap
    }

    // Where the service's runtime lives on the sprite (what its bootstrap
    // writes to).
    mountPath(framework: AgentFramework): string | undefined {
        if (framework === 'hermes') return HERMES_HOME
        if (framework === 'openclaw') return OPENCLAW_WORKSPACE
        return this.extensions.get(framework)?.spriteService?.mountPath
    }
}
