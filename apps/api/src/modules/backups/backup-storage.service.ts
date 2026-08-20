import { Readable, Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import {
    DeleteObjectCommand,
    GetObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface BackupUploadResult {
    bytes: number
    sha256: string
}

export interface BackupDownloadResult {
    stream: AsyncIterable<Uint8Array>
    size: number | null
}

interface BackupS3Config {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle: boolean
    prefix: string
}

@Injectable()
export class BackupStorageService {
    private clientCache: { key: string; client: S3Client } | null = null

    constructor(private readonly config: ConfigService) {}

    assertConfigured(): void {
        this.readConfig()
    }

    retentionCount(): number {
        const raw = Number(this.config.get<string>('BACKUP_RETENTION_COUNT'))
        return Number.isSafeInteger(raw) && raw > 0 ? raw : 20
    }

    objectKey(input: {
        userId: string
        agentId: string
        backupId: string
    }): string {
        const cfg = this.readConfig()
        const prefix = cfg.prefix.replace(/^\/+|\/+$/g, '')
        return [
            prefix,
            safeSegment(input.userId),
            safeSegment(input.agentId),
            `${safeSegment(input.backupId)}.tar.gz`
        ]
            .filter(Boolean)
            .join('/')
    }

    async upload(
        key: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<BackupUploadResult> {
        const cfg = this.readConfig()
        const client = this.clientFor(cfg)
        const hash = createHash('sha256')
        let bytes = 0
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                bytes += buf.length
                hash.update(buf)
                callback(null, buf)
            }
        })
        const body = Readable.from(stream).pipe(meter)
        await new Upload({
            client,
            params: {
                Bucket: cfg.bucket,
                Key: key,
                Body: body,
                ContentType: 'application/gzip'
            }
        }).done()
        return { bytes, sha256: hash.digest('hex') }
    }

    async download(key: string): Promise<BackupDownloadResult> {
        const cfg = this.readConfig()
        const res = await this.clientFor(cfg).send(
            new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
        )
        if (!res.Body) throw new Error(`backup object ${key} has no body`)
        return {
            stream: toAsyncIterable(res.Body),
            size: res.ContentLength ?? null
        }
    }

    async deleteObject(key: string): Promise<void> {
        const cfg = this.readConfig()
        await this.clientFor(cfg).send(
            new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })
        )
    }

    private readConfig(): BackupS3Config {
        const endpoint = this.config.get<string>('BACKUP_S3_ENDPOINT')?.trim()
        const bucket = this.config.get<string>('BACKUP_S3_BUCKET')?.trim()
        const accessKeyId = this.config
            .get<string>('BACKUP_S3_ACCESS_KEY_ID')
            ?.trim()
        const secretAccessKey = this.config
            .get<string>('BACKUP_S3_SECRET_ACCESS_KEY')
            ?.trim()
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
            throw new ServiceUnavailableException(
                'backup S3 storage is not configured'
            )
        return {
            endpoint,
            bucket,
            accessKeyId,
            secretAccessKey,
            region:
                this.config.get<string>('BACKUP_S3_REGION')?.trim() ||
                'us-east-1',
            forcePathStyle:
                this.config.get<string>('BACKUP_S3_FORCE_PATH_STYLE') !==
                'false',
            prefix:
                this.config.get<string>('BACKUP_S3_PREFIX')?.trim() ||
                'agent-workspace-backups'
        }
    }

    private clientFor(cfg: BackupS3Config): S3Client {
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

export const meteredStream = (
    stream: AsyncIterable<Uint8Array>
): {
    stream: AsyncIterable<Uint8Array>
    result: Promise<BackupUploadResult>
} => {
    const hash = createHash('sha256')
    let bytes = 0
    let resolve!: (value: BackupUploadResult) => void
    let reject!: (err: Error) => void
    const result = new Promise<BackupUploadResult>((res, rej) => {
        resolve = res
        reject = rej
    })
    return {
        result,
        stream: {
            [Symbol.asyncIterator]: async function* () {
                try {
                    for await (const chunk of stream) {
                        const buf = Buffer.isBuffer(chunk)
                            ? chunk
                            : Buffer.from(chunk)
                        bytes += buf.length
                        hash.update(buf)
                        yield buf
                    }
                    resolve({ bytes, sha256: hash.digest('hex') })
                } catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)))
                    throw err
                }
            }
        }
    }
}

const toAsyncIterable = (body: unknown): AsyncIterable<Uint8Array> => {
    if (body && typeof body === 'object' && Symbol.asyncIterator in body)
        return body as AsyncIterable<Uint8Array>
    throw new Error('S3 response body is not streamable')
}

const safeSegment = (value: string): string =>
    value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96)
