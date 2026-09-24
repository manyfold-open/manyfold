import { UnknownFrameworkError, type AgentFramework } from '@manyfold/shared'
import {
    Injectable,
    InternalServerErrorException,
    Optional
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { K8sFrameworkBootstrap } from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import { OpenClawBootstrap } from '@/modules/agents/bootstrap/openclaw'
import { HermesBootstrap } from '@/modules/agents/bootstrap/hermes'
import { ClaudeCodeK8sBootstrap } from '@/modules/agents/bootstrap/claude-code-k8s'
import { CodexK8sBootstrap } from '@/modules/agents/bootstrap/codex-k8s'
import { GeminiCliK8sBootstrap } from '@/modules/agents/bootstrap/gemini-k8s'
import { PiK8sBootstrap } from '@/modules/agents/bootstrap/pi-k8s'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'

// The k8s bootstrap of every framework that runs in a pod: the core ones,
// then whatever a framework module registered (ADR-0034).
@Injectable()
export class K8sBootstraps {
    private readonly core: ReadonlyMap<string, K8sFrameworkBootstrap>

    constructor(
        private readonly config: ConfigService,
        openclaw: OpenClawBootstrap,
        hermes: HermesBootstrap,
        claudeCode: ClaudeCodeK8sBootstrap,
        codex: CodexK8sBootstrap,
        geminiCli: GeminiCliK8sBootstrap,
        pi: PiK8sBootstrap,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry()
    ) {
        this.core = new Map(
            [openclaw, hermes, claudeCode, codex, geminiCli, pi].map((b) => [
                b.framework,
                b
            ])
        )
    }

    get(framework: AgentFramework): K8sFrameworkBootstrap {
        const bootstrap =
            this.core.get(framework) ??
            this.extensions.get(framework)?.k8sBootstrap
        if (!bootstrap) throw new UnknownFrameworkError(framework)
        return bootstrap
    }

    image(framework: AgentFramework): string {
        const key = this.get(framework).imageEnvKey
        const image = this.config.get<string>(key)
        if (!image) throw new InternalServerErrorException(`${key} not set`)
        return image
    }
}
