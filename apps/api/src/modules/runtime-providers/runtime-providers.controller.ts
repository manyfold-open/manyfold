import type {
    RuntimeProviderProbeResult,
    RuntimeProviderSummary
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { RuntimeProvidersAdminService } from './runtime-providers-admin.service'
import {
    CreateRuntimeProviderDto,
    UpdateRuntimeProviderDto
} from './dto/runtime-provider.dto'

@Controller('admin/runtime-providers')
@UseGuards(AuthGuard, AdminGuard)
export class RuntimeProvidersController {
    constructor(private readonly providers: RuntimeProvidersAdminService) {}

    @Get()
    list(): Promise<RuntimeProviderSummary[]> {
        return this.providers.list()
    }

    @Get(':id')
    get(@Param('id') id: string): Promise<RuntimeProviderSummary> {
        return this.providers.get(id)
    }

    @Post()
    @HttpCode(201)
    create(
        @Body() dto: CreateRuntimeProviderDto
    ): Promise<RuntimeProviderSummary> {
        return this.providers.create(dto)
    }

    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() dto: UpdateRuntimeProviderDto
    ): Promise<RuntimeProviderSummary> {
        return this.providers.update(id, dto)
    }

    @Delete(':id')
    @HttpCode(204)
    async remove(@Param('id') id: string): Promise<void> {
        await this.providers.remove(id)
    }

    @Post(':id/probe')
    @HttpCode(200)
    probe(@Param('id') id: string): Promise<RuntimeProviderProbeResult> {
        return this.providers.probe(id)
    }
}
