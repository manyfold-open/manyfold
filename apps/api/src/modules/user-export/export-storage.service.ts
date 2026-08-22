import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
    DeleteObjectCommand,
    GetObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import {
    Injectable,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

// Takeout bundles live beside chat uploads: same bucket, same CHAT_UPLOAD_S3_*
// credentials, but under the independent `takeout/` prefix (ADR-0023 §9.2) so
// the chat-upload TTL machinery never touches them. Retention is enforced by
// the export sweep against user_exports.expires_at — a bucket lifecycle rule
// cannot be assumed, least of all on self-hosted S3-compatibles. The disk
// fallback mirrors chat-upload's CHAT_UPLOAD_ALLOW_DISK escape hatch so a
// self-hosted install without S3 still satisfies a GDPR portability request.
const TAKEOUT_PREFIX = 'takeout'

interface TakeoutS3Config {
    kind: 's3'
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle: boolean
}

interface TakeoutDiskConfig {
    kind: 'disk'
    dir: string
}

type TakeoutConfig = TakeoutS3Config | TakeoutDiskConfig

@Injectable()
export class UserExportStorageService {
    private clientCache: { key: string; client: S3Client } | null = null

    constructor(private readonly config: ConfigService) {}

    // Fail at request time, not at sweep time: a POST /me/export on an
    // install with no storage configured must be a loud 503, never a queued
    // row that fails an hour later.
    assertConfigured(): void {
        this.readConfig()
    }

    objectKey(userId: string, exportId: string): string {
        return `${TAKEOUT_PREFIX}/${safeSegment(userId)}/${safeSegment(exportId)}.zip`
    }

    async putFile(key: string, path: string): Promise<void> {
        const cfg = this.readConfig()
        if (cfg.kind === 's3') {
            await new Upload({
                client: this.clientFor(cfg),
                params: {
                    Bucket: cfg.bucket,
                    Key: key,
                    Body: createReadStream(path),
                    ContentType: 'application/zip'
                }
            }).done()
            return
        }
        const target = join(cfg.dir, key)
        await mkdir(dirname(target), { recursive: true })
        await pipeline(createReadStream(path), createWriteStream(target))
    }

    async read(key: string): Promise<AsyncIterable<Uint8Array>> {
        const cfg = this.readConfig()
        if (cfg.kind === 's3') {
            const res = await this.clientFor(cfg).send(
                new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
            )
            if (!res.Body) throw new NotFoundException('export bundle')
            return res.Body as AsyncIterable<Uint8Array>
        }
        return createReadStream(join(cfg.dir, key))
    }

    async delete(key: string): Promise<void> {
        const cfg = this.readConfig()
        if (cfg.kind === 's3') {
            await this.clientFor(cfg).send(
                new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })
            )
            return
        }
        await rm(join(cfg.dir, key), { force: true })
    }

    private readConfig(): TakeoutConfig {
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
                    this.config.get<string>(
                        'CHAT_UPLOAD_S3_FORCE_PATH_STYLE'
                    ) !== 'false'
            }
        if (this.config.get<string>('CHAT_UPLOAD_ALLOW_DISK') === 'true')
            return { kind: 'disk', dir: join(tmpdir(), 'manyfold-takeout') }
        throw new ServiceUnavailableException(
            'export storage is not configured (set CHAT_UPLOAD_S3_* or CHAT_UPLOAD_ALLOW_DISK)'
        )
    }

    private clientFor(cfg: TakeoutS3Config): S3Client {
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

const safeSegment = (value: string): string =>
    value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96)
