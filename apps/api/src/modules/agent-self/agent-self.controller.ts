import type { AgentSelfConnectionsResponse } from '@manyfold/shared'
import {
    BadRequestException,
    Controller,
    Get,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AllowRuntimeSelf } from '@/common/decorators/allow-runtime-self.decorator'
import { AllowBoundTokenWithoutSubject } from '@/common/decorators/subject-agent.decorator'
import { principalAgentId } from '@/modules/auth/auth-principal'
import { ConnectionsService } from '@/modules/connections/connections.service'

// The agent's own context, addressed implicitly by the bound runtime token —
// no path param, no agent_permissions scope. @AllowRuntimeSelf lets the runtime
// identity through for free; @AllowBoundTokenWithoutSubject gives the guard a
// classification so it doesn't demand api.full (mirrors /auth/whoami).
@Controller('agent-self')
@UseGuards(AuthGuard)
export class AgentSelfController {
    constructor(private readonly connections: ConnectionsService) {}

    @Get('connections')
    @AllowRuntimeSelf()
    @AllowBoundTokenWithoutSubject('agent reads its own linked connections')
    async agentConnections(
        @CurrentUser() user: AuthPrincipal
    ): Promise<AgentSelfConnectionsResponse> {
        const agentId = principalAgentId(user)
        if (!agentId)
            throw new BadRequestException('agent runtime context required')
        return {
            connections:
                await this.connections.resolveAgentConnectionsById(agentId)
        }
    }
}
