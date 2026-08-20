import {
    AgentFramework,
    createObjectId
} from '@manyfold/shared'
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agentRuntimes, type AgentRuntimeRow, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { UserExternalAgentProvidersService } from '@/modules/user-external-agent-providers/user-external-agent-providers.service'

export interface ExternalProvisionInput {
    userId: string
    framework: AgentFramework
    runtimeName: string
    binding: { providerId: string; remoteRef: Record<string, unknown> }
}

export interface ExternalProvisionOutput {
    runtime: AgentRuntimeRow
}

@Injectable()
export class ExternalAgentProvisioner {
    private readonly log = new Logger(ExternalAgentProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly providers: UserExternalAgentProvidersService
    ) {}

    async provisionRuntime(
        input: ExternalProvisionInput
    ): Promise<ExternalProvisionOutput> {
        const provider = await this.providers.getOwned(
            input.userId,
            input.binding.providerId
        )
        if (provider.provider !== input.framework)
            throw new ConflictException(
                `external provider ${provider.id} is ${provider.provider}, not ${input.framework}`
            )
        const runtimeId = createObjectId('agentRuntime')
        const runtime = await this.runtimeAccess.reserveRuntime({
            id: runtimeId,
            userId: input.userId,
            name: input.runtimeName,
            framework: input.framework,
            kind: 'external',
            status: 'ready',
            mountPath: '/workspace',
            currentPhase: null
        })
        return { runtime }
    }

    async teardownRuntime(runtime: AgentRuntimeRow): Promise<void> {
        try {
            await this.db
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.id, runtime.id))
        } catch (err) {
            this.log.warn(
                `external runtime teardown failed for ${runtime.id}: ${(err as Error).message}`
            )
        }
    }
}
