import { Module } from '@nestjs/common'
import { CORE_MODULES, CORE_PROVIDERS } from '@/core-modules'
import { DefaultPortsModule } from '@/common/ports/default-ports.module'

// The open-source composition root: core modules plus the no-op/open port
// defaults. The commercial modules live only in the cloud root
// (apps/api-cloud/src/cloud-app.module.ts), which staging and prod deploy;
// this root is what smoke-boot, the self-host compose stack and the future
// public repository boot.
@Module({
    imports: [...CORE_MODULES, DefaultPortsModule],
    providers: [...CORE_PROVIDERS]
})
export class AppModule {}
