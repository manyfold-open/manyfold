import type {
    AgentPermissionsResponse,
    DenyPermissionBody,
    DenyPermissionResponse,
    GrantPermissionBody,
    ManageAgentPermissionsBody,
    PermissionConsentPreview,
    RequestPermissionBody,
    RequestPermissionResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Get,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AllowRuntimeSelf } from '@/common/decorators/allow-runtime-self.decorator'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { SubjectAgentFromPath } from '@/common/decorators/subject-agent.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AgentPermissionsService } from './agent-permissions.service'

@Controller()
@UseGuards(AuthGuard)
export class AgentPermissionsController {
    constructor(private readonly perms: AgentPermissionsService) {}

    // Owner reads the agent's current capability list (Agent detail >
    // Permissions). Human session only — bound to the agent the caller owns.
    @Get('agents/:id/permissions')
    @RequireAuthSession()
    @SubjectAgentFromPath('id')
    async list(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string
    ): Promise<AgentPermissionsResponse> {
        return this.perms.listForOwner(agentId, user.userId)
    }

    // Owner adds capabilities (no bearer minted).
    @Post('agents/:id/permissions')
    @HttpCode(200)
    @RequireAuthSession()
    @SubjectAgentFromPath('id')
    async add(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Body() body: ManageAgentPermissionsBody
    ): Promise<AgentPermissionsResponse> {
        return this.perms.addForOwner(agentId, user.userId, body?.scopes ?? [])
    }

    // Owner removes capabilities (no bearer minted).
    @Post('agents/:id/permissions/revoke')
    @HttpCode(200)
    @RequireAuthSession()
    @SubjectAgentFromPath('id')
    async remove(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Body() body: ManageAgentPermissionsBody
    ): Promise<AgentPermissionsResponse> {
        return this.perms.removeForOwner(
            agentId,
            user.userId,
            body?.scopes ?? []
        )
    }

    // Agent asks (with its own runtime identity) for the scope it's missing.
    // @AllowRuntimeSelf lets the runtime token through without that scope; the
    // guard still binds the subject to the token's own agentId.
    @Post('agents/:id/permissions/request')
    @HttpCode(200)
    @AllowRuntimeSelf()
    @SubjectAgentFromPath('id')
    async request(
        @Param('id') agentId: string,
        @Body() body: RequestPermissionBody
    ): Promise<RequestPermissionResponse> {
        return this.perms.createRequest({
            agentId,
            scopes: body?.scopes ?? []
        })
    }

    // Owner opens the consent URL; preview decodes the signed token to show
    // what the agent is asking for. Human session only.
    @Post('permission-requests/preview')
    @HttpCode(200)
    @RequireAuthSession()
    async preview(
        @CurrentUser() user: AuthPrincipal,
        @Body('token') token?: string
    ): Promise<PermissionConsentPreview> {
        return this.perms.previewConsent(token ?? '', user.userId)
    }

    // Owner approves a subset; APPENDS to agent_permissions, mints no bearer.
    @Post('permission-requests/grant')
    @HttpCode(200)
    @RequireAuthSession()
    async grant(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: GrantPermissionBody
    ): Promise<AgentPermissionsResponse> {
        return this.perms.grantConsent({
            token: body?.token ?? '',
            approverUserId: user.userId,
            approvedScopes: body?.approvedScopes ?? []
        })
    }

    // Owner refuses; records the decision so the request stops being offered.
    @Post('permission-requests/deny')
    @HttpCode(200)
    @RequireAuthSession()
    async deny(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: DenyPermissionBody
    ): Promise<DenyPermissionResponse> {
        return this.perms.denyConsent({
            token: body?.token ?? '',
            approverUserId: user.userId
        })
    }
}
