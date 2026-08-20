import { Module } from '@nestjs/common'
import { AgentsModule } from '@/modules/agents/agents.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { DaemonRateLimitService } from '@/modules/daemon/daemon-rate-limit.service'
import { RuntimeReportsController } from './runtime-reports.controller'
import { RuntimeReportsService } from './runtime-reports.service'

@Module({
    imports: [AgentsModule, AgentRuntimesModule],
    controllers: [RuntimeReportsController],
    // DaemonRateLimitService is a generic fixed-window limiter — providing a
    // local instance reuses the class without importing DaemonModule.
    providers: [RuntimeReportsService, DaemonRateLimitService]
})
export class RuntimeReportsModule {}
