import { Module } from '@nestjs/common'
import { ResourceEventsModule } from '@/modules/resource-events/resource-events.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { AgentRuntimesModule } from '@/modules/agent-runtimes/agent-runtimes.module'
import { K8sModule } from '@/modules/k8s/k8s.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import {
    AdminBackupsController,
    BackupsController
} from '@/modules/backups/backups.controller'
import { BackupsService } from '@/modules/backups/backups.service'
import { BackupStorageService } from '@/modules/backups/backup-storage.service'
import { WorkspaceRuntimeService } from '@/modules/backups/workspace-runtime.service'
import { BackupOperationsService } from '@/modules/backups/backup-operations.service'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'

@Module({
    imports: [
        ResourceEventsModule,
        AuthModule,
        SpritesAccountsModule,
        AgentRuntimesModule,
        K8sModule,
        DaemonModule
    ],
    controllers: [BackupsController, AdminBackupsController],
    providers: [
        AdminGuard,
        BackupsService,
        BackupStorageService,
        WorkspaceRuntimeService,
        BackupOperationsService,
        ServiceLeaseService
    ],
    exports: [BackupsService]
})
export class BackupsModule {}
