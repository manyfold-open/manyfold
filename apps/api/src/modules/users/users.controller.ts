import type {
    RuntimeAccessSummary,
    SdkUserSummary,
    UserFrameworkRuntimeOverridesSettings
} from '@manyfold/shared'
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { UsersService } from '@/modules/users/users.service'
import { UpdateUserRoleDto } from '@/modules/users/dto/update-user-role.dto'
import { UpdateUserPlanDto } from '@/modules/users/dto/update-user-plan.dto'
import { UpdateUserFrameworkRuntimeOverridesDto } from '@/modules/users/dto/update-user-framework-runtime-overrides.dto'
import { UpdateUserRuntimeAccessDto } from '@/modules/runtime-access/dto/runtime-access.dto'

@Controller('admin/users')
@UseGuards(AuthGuard, AdminGuard)
export class UsersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly runtimeAccess: RuntimeAccessService
    ) {}

    @Get()
    list(): Promise<SdkUserSummary[]> {
        return this.usersService.list()
    }

    @Get(':id/runtime-access')
    getRuntimeAccess(@Param('id') id: string): Promise<RuntimeAccessSummary> {
        return this.runtimeAccess.summary(id)
    }

    @Patch(':id/role')
    setRole(
        @Param('id') id: string,
        @Body() dto: UpdateUserRoleDto,
        @CurrentUser() caller: AuthPrincipal
    ): Promise<SdkUserSummary> {
        return this.usersService.setRole(id, caller.userId, dto.role)
    }

    @Patch(':id/runtime-access')
    setRuntimeAccess(
        @Param('id') id: string,
        @Body() dto: UpdateUserRuntimeAccessDto,
        @CurrentUser() caller: AuthPrincipal
    ): Promise<SdkUserSummary> {
        return this.usersService.setRuntimeAccess(id, caller.userId, dto)
    }

    @Patch(':id/plan')
    setPlan(
        @Param('id') id: string,
        @Body() dto: UpdateUserPlanDto,
        @CurrentUser() caller: AuthPrincipal
    ): Promise<SdkUserSummary> {
        return this.usersService.setPlan(id, caller.userId, dto.planId)
    }

    @Get(':id/framework-runtime-overrides')
    getFrameworkRuntimeOverrides(
        @Param('id') id: string
    ): Promise<UserFrameworkRuntimeOverridesSettings> {
        return this.usersService.getFrameworkRuntimeOverrides(id)
    }

    @Patch(':id/framework-runtime-overrides')
    setFrameworkRuntimeOverrides(
        @Param('id') id: string,
        @Body() dto: UpdateUserFrameworkRuntimeOverridesDto,
        @CurrentUser() caller: AuthPrincipal
    ): Promise<SdkUserSummary> {
        return this.usersService.setFrameworkRuntimeOverrides(
            id,
            caller.userId,
            dto
        )
    }
}
