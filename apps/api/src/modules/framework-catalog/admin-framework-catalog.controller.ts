import {
    BadRequestException,
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
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard } from '@/common/guards/auth.guard'
import {
    CreateFrameworkEnumDto,
    CreateFrameworkModelDto,
    UpdateFrameworkEnumDto,
    UpdateFrameworkModelDto
} from '@/modules/framework-catalog/dto/framework-catalog.dto'
import { FrameworkCatalogService } from '@/modules/framework-catalog/framework-catalog.service'
import {
    isConfigurableFramework,
    type ConfigurableFramework,
    type FrameworkCatalogView,
    type FrameworkEnumView,
    type FrameworkModelView
} from '@/modules/framework-catalog/framework-catalog.types'

@Controller('admin/framework-catalog')
@UseGuards(AuthGuard, AdminGuard)
export class AdminFrameworkCatalogController {
    constructor(private readonly catalog: FrameworkCatalogService) {}

    @Get(':framework')
    get(@Param('framework') framework: string): Promise<FrameworkCatalogView> {
        return this.catalog.getCatalog(this.requireFramework(framework), {
            activeOnly: false
        })
    }

    @Post(':framework/models')
    createModel(
        @Param('framework') framework: string,
        @Body() body: CreateFrameworkModelDto
    ): Promise<FrameworkModelView> {
        return this.catalog.createModel({
            framework: this.requireFramework(framework),
            modelKey: body.modelKey,
            kind: body.kind,
            displayName: body.displayName,
            capabilities: body.capabilities,
            sortOrder: body.sortOrder,
            isActive: body.isActive,
            isDefault: body.isDefault
        })
    }

    @Patch(':framework/models/:id')
    updateModel(
        @Param('framework') framework: string,
        @Param('id') id: string,
        @Body() body: UpdateFrameworkModelDto
    ): Promise<FrameworkModelView> {
        this.requireFramework(framework)
        return this.catalog.updateModel(id, body)
    }

    @Delete(':framework/models/:id')
    @HttpCode(204)
    async deleteModel(
        @Param('framework') framework: string,
        @Param('id') id: string
    ): Promise<void> {
        this.requireFramework(framework)
        await this.catalog.deactivateModel(id)
    }

    @Post(':framework/enums')
    createEnum(
        @Param('framework') framework: string,
        @Body() body: CreateFrameworkEnumDto
    ): Promise<FrameworkEnumView> {
        return this.catalog.createEnum({
            framework: this.requireFramework(framework),
            enumKey: body.enumKey,
            value: body.value,
            displayName: body.displayName,
            sortOrder: body.sortOrder,
            isActive: body.isActive,
            isDefault: body.isDefault
        })
    }

    @Patch(':framework/enums/:id')
    updateEnum(
        @Param('framework') framework: string,
        @Param('id') id: string,
        @Body() body: UpdateFrameworkEnumDto
    ): Promise<FrameworkEnumView> {
        this.requireFramework(framework)
        return this.catalog.updateEnum(id, body)
    }

    @Delete(':framework/enums/:id')
    @HttpCode(204)
    async deleteEnum(
        @Param('framework') framework: string,
        @Param('id') id: string
    ): Promise<void> {
        this.requireFramework(framework)
        await this.catalog.deactivateEnum(id)
    }

    private requireFramework(value: string): ConfigurableFramework {
        if (!isConfigurableFramework(value))
            throw new BadRequestException(
                `framework must be one of: claude-code, codex, gemini-cli`
            )
        return value
    }
}
