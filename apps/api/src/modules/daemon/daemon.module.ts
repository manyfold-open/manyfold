import { Module } from '@nestjs/common'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { RuntimeAccessModule } from '@/modules/runtime-access/runtime-access.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AdminDaemonController } from './admin-daemon.controller'
import { DaemonController } from './daemon.controller'
import { DaemonGateway } from './daemon.gateway'
import { DaemonAuthGuard } from './daemon-auth.guard'
import { DaemonTokenService } from './daemon-token.service'
import { DaemonHostService } from './daemon-host.service'
import { DaemonRegistryService } from './daemon-registry.service'
import { DaemonRuntimeSyncService } from './daemon-runtime-sync.service'
import { DaemonPresenceService } from './daemon-presence.service'
import { DaemonRateLimitService } from './daemon-rate-limit.service'
import { DaemonCliVersionService } from './daemon-cli-version.service'
import { CliVersionCatalogService } from './cli-version-catalog.service'
import { CliVersionsController } from './cli-versions.controller'
import { DaemonExecResumeService } from './daemon-exec-resume.service'

@Module({
    imports: [AuthModule, AdminSettingsModule, RuntimeAccessModule],
    controllers: [
        DaemonController,
        AdminDaemonController,
        CliVersionsController
    ],
    providers: [
        AdminGuard,
        DaemonGateway,
        DaemonAuthGuard,
        DaemonTokenService,
        DaemonHostService,
        DaemonRegistryService,
        DaemonRuntimeSyncService,
        DaemonPresenceService,
        DaemonRateLimitService,
        DaemonCliVersionService,
        CliVersionCatalogService,
        DaemonExecResumeService
    ],
    exports: [
        DaemonRegistryService,
        DaemonHostService,
        DaemonTokenService,
        DaemonRuntimeSyncService,
        DaemonExecResumeService,
        DaemonCliVersionService,
        CliVersionCatalogService
    ]
})
export class DaemonModule {
    constructor(registry: CapabilitiesRegistry) {
        registry.register('daemonRuntime')
    }
}
