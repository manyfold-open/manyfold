import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { ConnectionsModule } from '@/modules/connections/connections.module'
import { AgentSelfController } from './agent-self.controller'
import { AgentContextDocService } from './agent-context-doc.service'

@Module({
    imports: [AuthModule, ConnectionsModule],
    controllers: [AgentSelfController],
    providers: [AgentContextDocService],
    exports: [AgentContextDocService]
})
export class AgentSelfModule {}
