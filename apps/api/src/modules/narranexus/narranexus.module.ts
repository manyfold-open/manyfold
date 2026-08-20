import { Module } from '@nestjs/common'
import { NarraNexusAgentAdapter } from './narranexus-agent.adapter'

@Module({
    providers: [NarraNexusAgentAdapter],
    exports: [NarraNexusAgentAdapter]
})
export class NarraNexusModule {}
