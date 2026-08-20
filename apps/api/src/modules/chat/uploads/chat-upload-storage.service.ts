import {
    CHAT_UPLOAD_TTL_MS,
    createObjectId,
    isObjectId
} from '@manyfold/shared'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import {
    Injectable,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface StoredUpload {
    id: string
    name: string
    contentType: string
    size: number
    createdAt: string
}

interface ChatUploadS3Config {
    kind: 's3'
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle: boolean
    prefix: string
}

interface ChatUploadDiskConfig {
    kind: 'disk'
    dir: string
}

type ChatUploadConfig = ChatUploadS3Config | ChatUploadDiskConfig

@Injectable()
export class ChatUploadStorageService implements OnModuleInit, OnModuleDestroy {
    private clientCache: { key: string; client: S3Client } | null = null
    private sweepTimer: NodeJS.Timeout | null = null

    constructor(private readonly config: ConfigService) {}

    onModuleInit(): void {
        let cfg: ChatUploadConfig
        try {
            cfg = this.readConfig()
        } catch {
            return
        }
        if (cfg.kind !== 'disk') return
        this.sweepTimer = setInterval(
            () => {
                void this.sweepExpired(new Date()).catch(() => undefined)
            },
            CHAT_UPLOAD_TTL_MS
        )
        this.sweepTimer.unref()
    }

    onModuleDestroy(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        this.sweepTimer = null
    }

    async put(input: {
        userId: string
        agentId: string
        name: string
        contentType: string
        stream: AsyncIterable<Uint8Array>
    }): Promise<{ id: string; size: number }> {
        const id = createObjectId('chatUpload')
        const createdAt = new Date().toISOString()
        const cfg = this.readConfig()
        let bytes = 0
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                bytes += buf.length
                callback(null, buf)
            }
        })
        if (cfg.kind === 's3') {
            const body = Readable.from(input.stream).pipe(meter)
            await new Upload({
                client: this.clientFor(cfg),
                params: {
                    Bucket: cfg.bucket,
                    Key: this.objectKey(cfg, input.userId, input.agentId, id),
                    Body: body,
                    ContentType: input.contentType,
                    Metadata: {
                        name: Buffer.from(input.name).toString('base64'),
                        createdat: createdAt
                    }
                }
            }).done()
            return { id, size: bytes }
        }
        const path = this.diskPath(cfg, input.userId, input.agentId, id)
        await mkdir(dirname(path), { recursive: true })
        await pipeline(Readable.from(input.stream), meter, createWriteStream(path))
        await writeFile(
            `${path}.json`,
            JSON.stringify({
                name: input.name,
                contentType: input.contentType,
                size: bytes,
                createdAt
            })
        )
        return { id, size: bytes }
    }

    async stat(
        id: string,
        userId: string,
        agentId: string
    ): Promise<StoredUpload | null> {
        if (!isObjectId(id, 'chatUpload')) return null
        const cfg = this.readConfig()
        if (cfg.kind === 's3') {
            try {
                const res = await this.clientFor(cfg).send(
                    new HeadObjectCommand({
                        Bucket: cfg.bucket,
                        Key: this.objectKey(cfg, userId, agentId, id)
                    })
                )
                return {
                    id,
                    name: res.Metadata?.name
                        ? Buffer.from(res.Metadata.name, 'base64').toString(
                              'utf8'
                          )
                        : id,
                    contentType: res.ContentType ?? 'application/octet-stream',
                    size: res.ContentLength ?? 0,
                    createdAt: res.Metadata?.createdat ?? ''
                }
            } catch (err) {
                if (isNotFound(err)) return null
                throw err
            }
        }
        try {
            const meta = JSON.parse(
                await readFile(
                    `${this.diskPath(cfg, userId, agentId, id)}.json`,
                    'utf8'
                )
            ) as Omit<StoredUpload, 'id'>
            return { id, ...meta }
        } catch {
            return null
        }
    }

    async read(
        id: string,
        userId: string,
        agentId: string
    ): Promise<AsyncIterable<Uint8Array>> {
        const cfg = this.readConfig()
        if (cfg.kind === 's3') {
            const res = await this.clientFor(cfg).send(
                new GetObjectCommand({
                    Bucket: cfg.bucket,
                    Key: this.objectKey(cfg, userId, agentId, id)
                })
            )
            if (!res.Body) throw new NotFoundException(`chat upload ${id}`)
            return res.Body as AsyncIterable<Uint8Array>
        }
        return createReadStream(this.diskPath(cfg, userId, agentId, id))
    }

    async delete(id: string, userId: string, agentId: string): Promise<void> {
        const cfg = this.readConfig()
        if (cfg.kind === 's3') {
            await this.clientFor(cfg).send(
                new DeleteObjectCommand({
                    Bucket: cfg.bucket,
                    Key: this.objectKey(cfg, userId, agentId, id)
                })
            )
            return
        }
        const path = this.diskPath(cfg, userId, agentId, id)
        await rm(path, { force: true })
        await rm(`${path}.json`, { force: true })
    }

    async sweepExpired(now: Date): Promise<number> {
        let cfg: ChatUploadConfig
        try {
            cfg = this.readConfig()
        } catch {
            return 0
        }
        if (cfg.kind !== 'disk') return 0
        let entries: string[]
        try {
            entries = await readdir(cfg.dir, { recursive: true })
        } catch {
            return 0
        }
        const cutoff = now.getTime() - CHAT_UPLOAD_TTL_MS
        let removed = 0
        for (const entry of entries) {
            const full = join(cfg.dir, entry)
            try {
                const st = await fsStat(full)
                if (st.isFile() && st.mtimeMs < cutoff) {
                    await rm(full, { force: true })
                    removed += 1
                }
            } catch {
                continue
            }
        }
        return removed
    }

    private objectKey(
        cfg: ChatUploadS3Config,
        userId: string,
        agentId: string,
        id: string
    ): string {
        const prefix = cfg.prefix.replace(/^\/+|\/+$/g, '')
        return [
            prefix,
            safeSegment(userId),
            safeSegment(agentId),
            safeSegment(id)
        ]
            .filter(Boolean)
            .join('/')
    }

    private diskPath(
        cfg: ChatUploadDiskConfig,
        userId: string,
        agentId: string,
        id: string
    ): string {
        return join(
            cfg.dir,
            safeSegment(userId),
            safeSegment(agentId),
            safeSegment(id)
        )
    }

    private readConfig(): ChatUploadConfig {
        const endpoint = this.config
            .get<string>('CHAT_UPLOAD_S3_ENDPOINT')
            ?.trim()
        const bucket = this.config.get<string>('CHAT_UPLOAD_S3_BUCKET')?.trim()
        const accessKeyId = this.config
            .get<string>('CHAT_UPLOAD_S3_ACCESS_KEY_ID')
            ?.trim()
        const secretAccessKey = this.config
            .get<string>('CHAT_UPLOAD_S3_SECRET_ACCESS_KEY')
            ?.trim()
        if (endpoint && bucket && accessKeyId && secretAccessKey)
            return {
                kind: 's3',
                endpoint,
                bucket,
                accessKeyId,
                secretAccessKey,
                region:
                    this.config.get<string>('CHAT_UPLOAD_S3_REGION')?.trim() ||
                    'us-east-1',
                forcePathStyle:
                    this.config.get<string>('CHAT_UPLOAD_S3_FORCE_PATH_STYLE') !==
                    'false',
                prefix:
                    this.config.get<string>('CHAT_UPLOAD_S3_PREFIX')?.trim() ||
                    'chat-uploads'
            }
        if (this.config.get<string>('CHAT_UPLOAD_ALLOW_DISK') === 'true')
            return { kind: 'disk', dir: join(tmpdir(), 'manyfold-chat-uploads') }
        throw new ServiceUnavailableException(
            'chat-upload storage is not configured (set CHAT_UPLOAD_S3_* or CHAT_UPLOAD_ALLOW_DISK)'
        )
    }

    private clientFor(cfg: ChatUploadS3Config): S3Client {
        const key = JSON.stringify({
            endpoint: cfg.endpoint,
            region: cfg.region,
            forcePathStyle: cfg.forcePathStyle,
            accessKeyId: cfg.accessKeyId
        })
        if (this.clientCache?.key === key) return this.clientCache.client
        const client = new S3Client({
            endpoint: cfg.endpoint,
            region: cfg.region,
            forcePathStyle: cfg.forcePathStyle,
            credentials: {
                accessKeyId: cfg.accessKeyId,
                secretAccessKey: cfg.secretAccessKey
            }
        })
        this.clientCache = { key, client }
        return client
    }
}

const isNotFound = (err: unknown): boolean => {
    const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    if (meta?.httpStatusCode === 404) return true
    return (err as { name?: string }).name === 'NotFound'
}

const safeSegment = (value: string): string =>
    value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96)
