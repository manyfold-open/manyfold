import {
    FrameworkVersionCatalogEntry,
    VersionedFramework,
    isVersionedFramework
} from '@manyfold/shared'
import {
    BadRequestException,
    Controller,
    Get,
    Param,
    UseGuards
} from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'

@Controller('framework-versions')
@UseGuards(AuthGuard)
export class FrameworkVersionsController {
    constructor(private readonly versions: FrameworkVersionsService) {}

    @Get()
    async list(): Promise<FrameworkVersionCatalogEntry[]> {
        return this.versions.getCached()
    }

    @Get(':framework')
    async get(
        @Param('framework') framework: string
    ): Promise<FrameworkVersionCatalogEntry> {
        return this.versions.getForFramework(this.requireFramework(framework))
    }

    private requireFramework(value: string): VersionedFramework {
        if (!isVersionedFramework(value))
            throw new BadRequestException(
                'framework must be one of: claude-code, codex, gemini-cli, openclaw, hermes, narranexus'
            )
        return value
    }
}
