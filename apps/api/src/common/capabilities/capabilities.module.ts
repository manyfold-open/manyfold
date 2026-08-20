import { Global, Module } from '@nestjs/common'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'

@Global()
@Module({
    providers: [CapabilitiesRegistry],
    exports: [CapabilitiesRegistry]
})
export class CapabilitiesModule {}
