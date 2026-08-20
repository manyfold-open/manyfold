import type {
    FsEntrySdk,
    FsRootsResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    NotFoundException,
    Param,
    Post,
    Put,
    Query,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Agent } from '@manyfold/db'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AgentsService } from '@/modules/agents/agents.service'
import { streamFileToReply } from '@/modules/agents/files/files-download'
import {
    FilesContextBuilder,
    assertAgentReady,
    resolveSafePath,
    toSdkEntry,
    type FilesContext
} from '@/modules/agents/files/files-context'
import {
    assertUploadWithinLimit,
    rootCapabilities
} from '@/modules/agents/files/files-capabilities'
import type { FileWriteBody } from '@/modules/agents/files/files-upload'

const assertWritable = (ctx: FilesContext): void => {
    if (!ctx.root.writable)
        throw new ForbiddenException(`root "${ctx.root.id}" is read-only`)
}

// An octet-stream body arrives as the raw request stream; a missing body (no
// content-type, or content-length 0) means an empty file.
const toWriteBody = (
    body: Readable | Buffer | undefined
): FileWriteBody => {
    if (body === undefined) return Buffer.alloc(0)
    if (Buffer.isBuffer(body)) return body
    return body as AsyncIterable<Uint8Array>
}

const transportOf = (ctx: FilesContext): string =>
    ctx.root.transport ?? ctx.agent.runtime

const capabilitiesOf = (ctx: FilesContext) =>
    rootCapabilities({
        agent: ctx.agent,
        root: ctx.root,
        binaryWriteSafe: ctx.binaryWriteSafe !== false
    })

@Controller('admin/agents')
@UseGuards(AuthGuard, AdminGuard)
export class AdminFilesController {
    constructor(
        private readonly agents: AgentsService,
        private readonly ctxBuilder: FilesContextBuilder
    ) {}

    @Get(':id/files/roots')
    async roots(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string
    ): Promise<FsRootsResponse> {
        const agent = await this.loadAgent(user.userId, agentId)
        return { roots: await this.ctxBuilder.resolveRootsForSdk(agent) }
    }

    @Get(':id/files/list')
    async list(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Query('path') rawPath: string,
        @Query('rootId') rootId?: string
    ): Promise<{ entries: FsEntrySdk[] }> {
        const ctx = await this.context(user.userId, agentId, rootId)
        const abs = resolveSafePath(ctx.mountPath, rawPath)
        const entries = await ctx.list(abs)
        return { entries: entries.map(toSdkEntry) }
    }

    @Get(':id/files/stat')
    async stat(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Query('path') rawPath: string,
        @Query('rootId') rootId?: string
    ): Promise<FsEntrySdk & { contentType: string }> {
        const ctx = await this.context(user.userId, agentId, rootId)
        const abs = resolveSafePath(ctx.mountPath, rawPath)
        const stat = await ctx.stat(abs)
        if (!stat) throw new NotFoundException(`no such file: ${rawPath}`)
        return { ...toSdkEntry(stat.entry), contentType: stat.contentType }
    }

    @Get(':id/files/read')
    async read(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Query('path') rawPath: string,
        @Res() reply: FastifyReply,
        @Query('rootId') rootId?: string
    ): Promise<void> {
        const ctx = await this.context(user.userId, agentId, rootId)
        const abs = resolveSafePath(ctx.mountPath, rawPath)
        const result = await ctx.read(abs)
        if (!result) throw new NotFoundException(`no such file: ${rawPath}`)
        await streamFileToReply(reply, result, {
            agentId,
            rootId: ctx.root.id,
            path: abs,
            transport: transportOf(ctx)
        })
    }

    @Put(':id/files/write')
    async write(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Query('path') rawPath: string,
        @Req() req: FastifyRequest,
        @Body() body: Readable | Buffer | undefined,
        @Query('rootId') rootId?: string
    ): Promise<{ ok: true }> {
        const ctx = await this.context(user.userId, agentId, rootId)
        assertWritable(ctx)
        const abs = resolveSafePath(ctx.mountPath, rawPath)
        // reject on the declared size before reading a byte; the adapters
        // re-check while consuming, so a wrong Content-Length cannot slip past
        const declared = Number(req.headers['content-length'] ?? 0)
        if (Number.isFinite(declared) && declared > 0)
            assertUploadWithinLimit(capabilitiesOf(ctx), declared, {
                rootId: ctx.root.id,
                transport: transportOf(ctx)
            })
        await ctx.write(abs, toWriteBody(body))
        return { ok: true }
    }

    @Post(':id/files/mkdir')
    async mkdir(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Body() body: { path?: string },
        @Query('rootId') rootId?: string
    ): Promise<{ ok: true }> {
        const ctx = await this.context(user.userId, agentId, rootId)
        assertWritable(ctx)
        const abs = resolveSafePath(ctx.mountPath, body?.path ?? '')
        await ctx.mkdir(abs)
        return { ok: true }
    }

    @Post(':id/files/mv')
    async mv(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Body() body: { from?: string; to?: string },
        @Query('rootId') rootId?: string
    ): Promise<{ ok: true }> {
        const ctx = await this.context(user.userId, agentId, rootId)
        assertWritable(ctx)
        const src = resolveSafePath(ctx.mountPath, body?.from ?? '')
        const dst = resolveSafePath(ctx.mountPath, body?.to ?? '')
        if (src === ctx.mountPath || dst === ctx.mountPath)
            throw new ForbiddenException('cannot move the mount root')
        await ctx.mv(src, dst)
        return { ok: true }
    }

    @Delete(':id/files/rm')
    async rm(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Query('path') rawPath: string,
        @Query('recursive') recursive?: string,
        @Query('rootId') rootId?: string
    ): Promise<{ ok: true }> {
        const ctx = await this.context(user.userId, agentId, rootId)
        assertWritable(ctx)
        const abs = resolveSafePath(ctx.mountPath, rawPath)
        if (abs === ctx.mountPath)
            throw new ForbiddenException('refusing to remove mount root')
        await ctx.rm(abs, recursive === 'true' || recursive === '1')
        return { ok: true }
    }

    private async loadAgent(
        callerUserId: string,
        agentId: string
    ): Promise<Agent> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            true
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        assertAgentReady(agent)
        return agent
    }

    private async context(
        callerUserId: string,
        agentId: string,
        rootId?: string
    ): Promise<FilesContext> {
        const agent = await this.loadAgent(callerUserId, agentId)
        return this.ctxBuilder.build(agent, rootId)
    }
}
