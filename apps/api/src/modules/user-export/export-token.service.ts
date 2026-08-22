import { createHmac, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

// Signed download links for takeout bundles (ADR-0023 §9.2) — the
// DeletionTokenService recipe: HMAC over the user_exports row id + expiry,
// keyed by API_CRYPTO_KEY, nothing stored. The download must work without a
// session because the admin-triggered support path serves grace-period users
// whose sessions are already revoked; the signature (plus the row still being
// ready and unexpired) is the whole credential, exactly like an S3 presigned
// GET. Unlike the deletion tokens these are NOT single-use — a download can
// legitimately be repeated — so the row's expires_at bounds the exposure.
@Injectable()
export class ExportTokenService {
    private readonly key: Buffer

    constructor(config: ConfigService) {
        const raw = config.get<string>('API_CRYPTO_KEY')?.trim()
        this.key = raw
            ? Buffer.from(raw, 'base64')
            : Buffer.from('manyfold-export-token')
    }

    mint(exportId: string, expiresAt: Date): string {
        const payload = `${exportId}.${expiresAt.getTime()}`
        return `${payload}.${this.sign(payload)}`
    }

    verify(token: string): string | null {
        const parts = (token ?? '').split('.')
        if (parts.length !== 3) return null
        const [exportId, expiryRaw, signature] = parts
        if (!exportId) return null
        const expiresAt = Number(expiryRaw)
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
        const payload = `${exportId}.${expiryRaw}`
        const expected = Buffer.from(this.sign(payload))
        const provided = Buffer.from(signature)
        if (provided.length !== expected.length) return null
        if (!timingSafeEqual(provided, expected)) return null
        return exportId
    }

    private sign(payload: string): string {
        return createHmac('sha256', this.key).update(payload).digest('hex')
    }
}
