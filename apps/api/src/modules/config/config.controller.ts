import type { CliMinimumVersionSettings } from '@manyfold/shared'
import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'

@Controller('config')
@UseGuards(AuthGuard)
export class AppConfigController {
    constructor(private readonly settings: AdminSettingsService) {}

    @Get('cli-minimum-version')
    getCliMinimumVersion(): Promise<CliMinimumVersionSettings> {
        return this.settings.getCachedCliMinimumVersion()
    }
}
