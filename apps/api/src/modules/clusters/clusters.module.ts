import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthModule } from '@/modules/auth/auth.module'
import { ClustersController } from '@/modules/clusters/clusters.controller'
import { ClustersService } from '@/modules/clusters/clusters.service'

@Module({
    imports: [AuthModule],
    controllers: [ClustersController],
    providers: [AdminGuard, ClustersService],
    exports: [ClustersService]
})
export class ClustersModule {}
