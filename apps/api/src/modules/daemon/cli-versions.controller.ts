import type { CliVersionCatalog } from '@manyfold/shared'
import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { CliVersionCatalogService } from './cli-version-catalog.service'

// Installable mf CLI versions for the web update pickers. Staging builds are
// only included in non-prod deploy envs (the service gates that).
@Controller('cli')
@UseGuards(AuthGuard)
export class CliVersionsController {
    constructor(private readonly catalog: CliVersionCatalogService) {}

    @Get('versions')
    async versions(): Promise<CliVersionCatalog> {
        return this.catalog.getCachedCatalog()
    }
}
