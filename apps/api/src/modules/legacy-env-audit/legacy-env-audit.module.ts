import { Module } from '@nestjs/common'
import { LegacyEnvAuditService } from './legacy-env-audit.service'

@Module({
    providers: [LegacyEnvAuditService]
})
export class LegacyEnvAuditModule {}
