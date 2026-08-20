import { Global, Module } from '@nestjs/common'
import { TelemetryService } from '@/common/telemetry/telemetry.service'

@Global()
@Module({
    providers: [TelemetryService],
    exports: [TelemetryService]
})
export class TelemetryModule {}
