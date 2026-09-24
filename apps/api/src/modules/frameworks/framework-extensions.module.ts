import { Global, Module } from '@nestjs/common'
import { FrameworkExtensionsRegistry } from './framework-extensions.registry'

@Global()
@Module({
    providers: [FrameworkExtensionsRegistry],
    exports: [FrameworkExtensionsRegistry]
})
export class FrameworkExtensionsModule {}
