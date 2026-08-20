import {
    BadRequestException,
    Controller,
    Get,
    Param,
    UseGuards
} from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { FrameworkCatalogService } from '@/modules/framework-catalog/framework-catalog.service'
import {
    isConfigurableFramework,
    type ConfigurableFramework,
    type FrameworkCatalogView
} from '@/modules/framework-catalog/framework-catalog.types'

@Controller('framework-catalog')
@UseGuards(AuthGuard)
export class FrameworkCatalogController {
    constructor(private readonly catalog: FrameworkCatalogService) {}

    @Get(':framework')
    async get(
        @Param('framework') framework: string
    ): Promise<FrameworkCatalogView> {
        return this.catalog.getCatalog(this.requireFramework(framework), {
            activeOnly: true
        })
    }

    private requireFramework(value: string): ConfigurableFramework {
        if (!isConfigurableFramework(value))
            throw new BadRequestException(
                `framework must be one of: claude-code, codex, gemini-cli`
            )
        return value
    }
}
