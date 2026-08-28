import { Module } from '@nestjs/common'
import { SelfHostPlanBackfillService } from '@/modules/self-host-plan-backfill/self-host-plan-backfill.service'

@Module({
    providers: [SelfHostPlanBackfillService],
    exports: [SelfHostPlanBackfillService]
})
export class SelfHostPlanBackfillModule {}
