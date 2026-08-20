import { Module } from '@nestjs/common'
import { ApiQuotaService } from './api-quota.service'

@Module({
    providers: [ApiQuotaService],
    exports: [ApiQuotaService]
})
export class ApiQuotaModule {}
