import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { ConnectionsModule } from '@/modules/connections/connections.module'
import { AgentSelfController } from './agent-self.controller'
import { AgentContextDocService } from './agent-context-doc.service'
import { SpriteShellEnvService } from './sprite-shell-env.service'

@Module({
    imports: [AuthModule, ConnectionsModule],
    controllers: [AgentSelfController],
    providers: [SpriteShellEnvService, AgentContextDocService],
    exports: [SpriteShellEnvService, AgentContextDocService]
})
export class AgentSelfModule {}
