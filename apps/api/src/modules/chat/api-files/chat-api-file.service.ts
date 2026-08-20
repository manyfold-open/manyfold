import {
    CHAT_UPLOAD_MAX_COUNT,
    CHAT_UPLOAD_MAX_FILE_BYTES,
    CHAT_UPLOAD_MAX_TOTAL_BYTES,
    CreateMessageAttachmentInput,
    CreateMessageUploadInput,
    chatCapabilitiesByFramework
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    FilesContextBuilder,
    resolveSafePath,
    type FilesContext
} from '@/modules/agents/files/files-context'
import { ChatUploadStorageService } from '@/modules/chat/uploads/chat-upload-storage.service'

export interface IngestFile {
    name: string
    contentType: string
    bytes: Buffer
}

export interface IngestedFiles {
    attachments: CreateMessageAttachmentInput[]
    uploads: CreateMessageUploadInput[]
}

// Server-side file ingestion for the OpenAI-compatible API: turn raw bytes into
// the right per-framework reference. Dify uses the upload store (`uploads`);
// every other attachment-capable framework writes into the agent workspace
// (`attachments`). Non-attachment frameworks are rejected.
@Injectable()
export class ChatApiFileService {
    private readonly logger = new Logger(ChatApiFileService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly files: FilesContextBuilder,
        @Optional()
        private readonly uploads?: ChatUploadStorageService,
        @Optional()
        private readonly telemetry?: TelemetryService
    ) {}

    async supportsAttachments(agentId: string): Promise<boolean> {
        const [agent] = await this.db
            .select({ framework: agents.framework })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) return false
        return chatCapabilitiesByFramework[agent.framework]?.attachments === true
    }

    async ingest(input: {
        userId: string
        agentId: string
        sessionId: string
        files: IngestFile[]
    }): Promise<IngestedFiles> {
        if (input.files.length === 0) return { attachments: [], uploads: [] }

        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, input.agentId))
            .limit(1)
        if (!agent) throw new NotFoundException(`agent ${input.agentId}`)
        if (!chatCapabilitiesByFramework[agent.framework]?.attachments)
            throw new BadRequestException(
                `agent framework ${agent.framework} does not support file attachments`
            )

        if (input.files.length > CHAT_UPLOAD_MAX_COUNT)
            throw new BadRequestException(
                `at most ${CHAT_UPLOAD_MAX_COUNT} files are allowed`
            )
        let total = 0
        for (const file of input.files) {
            if (file.bytes.length > CHAT_UPLOAD_MAX_FILE_BYTES)
                throw new BadRequestException(
                    `file ${file.name} exceeds ${CHAT_UPLOAD_MAX_FILE_BYTES} bytes`
                )
            total += file.bytes.length
        }
        if (total > CHAT_UPLOAD_MAX_TOTAL_BYTES)
            throw new BadRequestException(
                `files exceed ${CHAT_UPLOAD_MAX_TOTAL_BYTES} bytes total`
            )

        if (agent.framework === 'dify')
            return this.ingestUploads(input.userId, input.agentId, input.files)

        return this.ingestWorkspace(agent, input.sessionId, input.files)
    }

    private async ingestUploads(
        userId: string,
        agentId: string,
        files: IngestFile[]
    ): Promise<IngestedFiles> {
        if (!this.uploads)
            throw new ServiceUnavailableException(
                'chat-upload storage is not configured'
            )
        const uploads: CreateMessageUploadInput[] = []
        for (const file of files) {
            const { id } = await this.uploads.put({
                userId,
                agentId,
                name: file.name,
                contentType: file.contentType,
                stream: Readable.from(file.bytes)
            })
            uploads.push({
                uploadId: id,
                name: file.name,
                contentType: file.contentType,
                size: file.bytes.length
            })
        }
        return { attachments: [], uploads }
    }

    private async ingestWorkspace(
        agent: Parameters<FilesContextBuilder['build']>[0],
        sessionId: string,
        files: IngestFile[]
    ): Promise<IngestedFiles> {
        const ctx = await this.files.build(agent, 'workspace')
        if (ctx.binaryWriteSafe === false)
            throw new BadRequestException(
                'file attachments are not supported for agents on self-owned computers until the daemon CLI is upgraded'
            )
        const relDir = `chat-attachments/${sessionId}/${randomUUID()}`
        await ctx.mkdir(resolveSafePath(ctx.mountPath, relDir))
        const used = new Set<string>()
        const attachments: CreateMessageAttachmentInput[] = []
        for (const file of files) {
            const name = uniqueName(sanitizeFilename(file.name), used)
            const relPath = `${relDir}/${name}`
            const absPath = resolveSafePath(ctx.mountPath, relPath)
            try {
                await ctx.write(absPath, file.bytes)
            } catch (err) {
                // A proxied write can fail after the bytes landed — the
                // narranexus gateway has returned 502 with the file already on
                // disk (#577). The disk is the authority: account the file as
                // written only when the full content verifiably arrived.
                if (!(await this.writeLanded(ctx, absPath, file.bytes.length)))
                    throw err
                this.logger.warn(
                    `attachment write for agent=${agent.id} path=${relPath} reported failure but the file landed — accounting as written: ${(err as Error).message}`
                )
                this.telemetry?.event('chat.attachment.write_reconciled', {
                    agentId: agent.id,
                    path: relPath,
                    size: file.bytes.length
                })
            }
            attachments.push({
                path: relPath,
                rootId: 'workspace',
                name,
                contentType: file.contentType,
                size: file.bytes.length
            })
        }
        return { attachments, uploads: [] }
    }

    private async writeLanded(
        ctx: FilesContext,
        absPath: string,
        expectedSize: number
    ): Promise<boolean> {
        try {
            const stat = await ctx.stat(absPath)
            return (
                stat?.entry.type === 'file' && stat.entry.size === expectedSize
            )
        } catch {
            return false
        }
    }

    // Read files the agent referenced in its reply out of the workspace so a
    // channel can attach them outbound. Best-effort: unreadable/oversized/
    // missing files are skipped, and frameworks without a readable workspace
    // return nothing. Caps are enforced before buffering each file.
    async readWorkspaceFiles(
        agentId: string,
        refs: OutboundFileRef[],
        caps: OutboundFileCaps = DEFAULT_OUTBOUND_FILE_CAPS
    ): Promise<OutboundFile[]> {
        if (refs.length === 0) return []
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent || agent.framework === 'dify') return []
        if (!chatCapabilitiesByFramework[agent.framework]?.attachments) return []
        let ctx
        try {
            ctx = await this.files.build(agent, 'workspace')
        } catch {
            return []
        }
        const out: OutboundFile[] = []
        let total = 0
        for (const ref of refs.slice(0, caps.maxFiles)) {
            try {
                const abs = resolveSafePath(ctx.mountPath, ref.relPath)
                const stat = await ctx.stat(abs)
                if (!stat || stat.entry.type !== 'file') continue
                if (stat.entry.size > caps.maxFileBytes) continue
                if (total + stat.entry.size > caps.maxTotalBytes) break
                const read = await ctx.read(abs)
                if (!read) continue
                const bytes = await collectStream(read.stream)
                if (bytes.length > caps.maxFileBytes) continue
                if (total + bytes.length > caps.maxTotalBytes) break
                total += bytes.length
                out.push({
                    name: ref.name,
                    relPath: ref.relPath,
                    contentType: read.contentType,
                    bytes
                })
            } catch {
                continue
            }
        }
        return out
    }
}

export interface OutboundFileRef {
    relPath: string
    name: string
}

export interface OutboundFile {
    name: string
    relPath: string
    contentType: string
    bytes: Buffer
}

export interface OutboundFileCaps {
    maxFiles: number
    maxFileBytes: number
    maxTotalBytes: number
}

export const DEFAULT_OUTBOUND_FILE_CAPS: OutboundFileCaps = {
    maxFiles: 4,
    maxFileBytes: 10 * 1024 * 1024,
    maxTotalBytes: 25 * 1024 * 1024
}

const collectStream = async (
    stream: AsyncIterable<Uint8Array | Buffer>
): Promise<Buffer> => {
    const parts: Buffer[] = []
    for await (const chunk of stream)
        parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(parts)
}

// Reduce an attacker-controlled filename to one safe path segment: basename
// only, allowlist chars, strip leading dots (kills "." / ".." / dotfiles).
export const sanitizeFilename = (raw: string): string => {
    const base = raw.split(/[\\/]/).pop() ?? ''
    const cleaned = base
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 200)
    return cleaned || 'file'
}

export const uniqueName = (name: string, used: Set<string>): string => {
    if (!used.has(name)) {
        used.add(name)
        return name
    }
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 1; ; i += 1) {
        const candidate = `${stem}-${i}${ext}`
        if (!used.has(candidate)) {
            used.add(candidate)
            return candidate
        }
    }
}
