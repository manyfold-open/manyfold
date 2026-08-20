import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { UserExternalAgentProvidersController } from '@/modules/user-external-agent-providers/user-external-agent-providers.controller'
import { UserExternalAgentProvidersService } from '@/modules/user-external-agent-providers/user-external-agent-providers.service'

@Module({
    imports: [AuthModule],
    controllers: [UserExternalAgentProvidersController],
    providers: [UserExternalAgentProvidersService],
    exports: [UserExternalAgentProvidersService]
})
export class UserExternalAgentProvidersModule {}
