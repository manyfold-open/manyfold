import { Module } from '@nestjs/common'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { A2aTimeoutEnvMigrationService } from './a2a-timeout-env-migration.service'

@Module({
    imports: [AdminSettingsModule],
    providers: [A2aTimeoutEnvMigrationService]
})
export class A2aTimeoutEnvMigrationModule {}
