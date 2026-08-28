import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { ModelProvidersModule } from '@/modules/model-providers/model-providers.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { UsersController } from '@/modules/users/users.controller'
import { AdminPlansController } from '@/modules/users/admin-plans.controller'
import { UsersService } from '@/modules/users/users.service'

@Module({
    imports: [AuthModule, ModelProvidersModule, RuntimeAccessModule],
    controllers: [UsersController, AdminPlansController],
    providers: [AdminGuard, UsersService],
    exports: [UsersService]
})
export class UsersModule {}
