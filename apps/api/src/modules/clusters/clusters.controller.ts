import type {
    K8sClusterProbeResult,
    K8sClusterSummary
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Put,
    UseGuards
} from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { ClustersService } from '@/modules/clusters/clusters.service'
import { UpsertClusterDto } from '@/modules/clusters/dto/upsert-cluster.dto'

@Controller('admin/clusters')
@UseGuards(AuthGuard, AdminGuard)
export class ClustersController {
    constructor(private readonly clusters: ClustersService) {}

    @Get()
    list(): Promise<K8sClusterSummary[]> {
        return this.clusters.list()
    }

    @Get(':id')
    get(@Param('id') id: string): Promise<K8sClusterSummary> {
        return this.clusters.get(id)
    }

    @Post()
    @HttpCode(201)
    create(@Body() dto: UpsertClusterDto): Promise<K8sClusterSummary> {
        return this.clusters.create(dto)
    }

    @Put(':id')
    update(
        @Param('id') id: string,
        @Body() dto: UpsertClusterDto
    ): Promise<K8sClusterSummary> {
        return this.clusters.update(id, dto)
    }

    @Delete(':id')
    @HttpCode(204)
    async remove(@Param('id') id: string): Promise<void> {
        await this.clusters.remove(id)
    }

    @Post(':id/probe')
    @HttpCode(200)
    probe(@Param('id') id: string): Promise<K8sClusterProbeResult> {
        return this.clusters.probe(id)
    }
}
