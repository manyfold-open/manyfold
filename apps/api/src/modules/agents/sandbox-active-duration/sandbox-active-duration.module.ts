import { Module } from '@nestjs/common'
import { SandboxActiveDurationService } from './sandbox-active-duration.service'

@Module({
    providers: [SandboxActiveDurationService],
    exports: [SandboxActiveDurationService]
})
export class SandboxActiveDurationModule {}
