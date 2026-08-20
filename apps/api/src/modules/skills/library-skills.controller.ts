import type {
    GetLibrarySkillShareResult,
    ImportLibrarySkillResult,
    LibrarySkillDetail,
    LibrarySkillImportConflict,
    LibrarySkillSummary,
    PushLibrarySkillResult,
    ShareLibrarySkillResult
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    PayloadTooLargeException,
    Post,
    Put,
    Query,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    AllowBoundTokenWithoutSubject,
    DenyBoundToken
} from '@/common/decorators/subject-agent.decorator'
import {
    CreateLibrarySkillDto,
    ImportLibrarySkillDto,
    PushLibrarySkillDto,
    UpdateLibrarySkillDto,
    UpsertLibrarySkillFileDto
} from './dto/skills.dto'
import { LibrarySkillSharesService } from './library-skill-shares.service'
import { LibrarySkillsService } from './library-skills.service'
import { MAX_LIBRARY_SKILL_ARCHIVE_BYTES } from './skill-utils'

const IMPORT_CONFLICT_MODES: LibrarySkillImportConflict[] = [
    'fail',
    'overwrite',
    'rename'
]

@Controller('skills/library')
@UseGuards(AuthGuard)
export class LibrarySkillsController {
    constructor(
        private readonly service: LibrarySkillsService,
        private readonly sharesService: LibrarySkillSharesService
    ) {}

    @Get()
    @RequireApiTokenScope('skills:read')
    @AllowBoundTokenWithoutSubject(
        'library skills are user-scoped content agents may read'
    )
    list(@CurrentUser() user: AuthPrincipal): Promise<LibrarySkillSummary[]> {
        return this.service.list(user.userId)
    }

    @Post()
    @HttpCode(201)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateLibrarySkillDto
    ): Promise<LibrarySkillDetail> {
        return this.service.create(user.userId, dto)
    }

    @Post('import')
    @HttpCode(200)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    import(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: ImportLibrarySkillDto
    ): Promise<ImportLibrarySkillResult> {
        return this.service.importFromSource(user.userId, dto)
    }

    @Post('import/archive')
    @HttpCode(200)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    async importArchive(
        @CurrentUser() user: AuthPrincipal,
        @Req() req: FastifyRequest,
        @Query('onConflict') onConflict?: string
    ): Promise<ImportLibrarySkillResult> {
        const mode = parseConflictMode(onConflict)
        const file = await req.file({
            limits: { fileSize: MAX_LIBRARY_SKILL_ARCHIVE_BYTES, files: 1 }
        })
        if (!file) throw new BadRequestException('file is required')
        let data: Buffer
        try {
            data = await file.toBuffer()
        } catch {
            throw new PayloadTooLargeException(
                `archive exceeds ${MAX_LIBRARY_SKILL_ARCHIVE_BYTES} bytes`
            )
        }
        if (file.file.truncated)
            throw new PayloadTooLargeException(
                `archive exceeds ${MAX_LIBRARY_SKILL_ARCHIVE_BYTES} bytes`
            )
        return this.service.importFromArchive(
            user.userId,
            data,
            file.filename || 'skill.zip',
            mode
        )
    }

    @Get(':id')
    @RequireApiTokenScope('skills:read')
    @AllowBoundTokenWithoutSubject(
        'library skills are user-scoped content agents may read'
    )
    get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<LibrarySkillDetail> {
        return this.service.get(user.userId, id)
    }

    @Patch(':id')
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateLibrarySkillDto
    ): Promise<LibrarySkillDetail> {
        return this.service.update(user.userId, id, dto)
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('force') force?: string
    ): Promise<void> {
        await this.service.remove(user.userId, id, force === 'true')
    }

    @Put(':id/files')
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    upsertFile(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpsertLibrarySkillFileDto
    ): Promise<LibrarySkillDetail> {
        return this.service.upsertFile(user.userId, id, dto)
    }

    @Delete(':id/files/:fileId')
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    deleteFile(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('fileId') fileId: string
    ): Promise<LibrarySkillDetail> {
        return this.service.deleteFile(user.userId, id, fileId)
    }

    @Post(':id/push')
    @HttpCode(200)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    push(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: PushLibrarySkillDto
    ): Promise<PushLibrarySkillResult> {
        return this.service.push(user.userId, id, dto.agentIds)
    }

    @Post(':id/share')
    @HttpCode(200)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    share(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ShareLibrarySkillResult> {
        return this.sharesService.createShare(user.userId, id)
    }

    @Delete(':id/share')
    @HttpCode(204)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    async unshare(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.sharesService.revokeShare(user.userId, id)
    }

    @Get(':id/share')
    @RequireApiTokenScope('skills:read')
    @AllowBoundTokenWithoutSubject(
        'library skills are user-scoped content agents may read'
    )
    getShare(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<GetLibrarySkillShareResult> {
        return this.sharesService.getShare(user.userId, id)
    }

    @Get(':id/export')
    @RequireApiTokenScope('skills:read')
    @AllowBoundTokenWithoutSubject(
        'library skills are user-scoped content agents may read'
    )
    async export(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Res() reply: FastifyReply
    ): Promise<void> {
        const { filename, data } = await this.service.exportArchive(
            user.userId,
            id
        )
        await reply
            .header('content-type', 'application/zip')
            .header(
                'content-disposition',
                `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`
            )
            .header('cache-control', 'no-store')
            .send(data)
    }
}

const parseConflictMode = (
    value: string | undefined
): LibrarySkillImportConflict => {
    if (value === undefined) return 'fail'
    if ((IMPORT_CONFLICT_MODES as string[]).includes(value))
        return value as LibrarySkillImportConflict
    throw new BadRequestException(
        `onConflict must be one of ${IMPORT_CONFLICT_MODES.join(', ')}`
    )
}
