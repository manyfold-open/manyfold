import {
    Controller,
    HttpCode,
    NotFoundException,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { NarraNexusSyncService } from './narranexus-sync.service'

// Manual drift-repair entry: forces a reconcile regardless of the debounce
// window, for operators recovering a runtime whose events were lost.
@Controller('admin/narranexus-sync')
@UseGuards(AuthGuard, AdminGuard)
export class NarraNexusSyncAdminController {
    constructor(
        private readonly sync: NarraNexusSyncService,
        private readonly runtimes: AgentRuntimesService
    ) {}

    @Post(':runtimeId/reconcile')
    @HttpCode(202)
    async reconcile(
        @Param('runtimeId') runtimeId: string
    ): Promise<{ queued: true }> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime || runtime.framework !== 'narranexus')
            throw new NotFoundException('narranexus runtime not found')
        this.sync.touchRuntime(runtimeId, { external: true, force: true })
        return { queued: true }
    }
}
