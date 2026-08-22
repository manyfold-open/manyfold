import { createHmac, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export type DeletionTokenPurpose = 'confirm' | 'restore'

// Signed single-use links for the self-serve deletion flow (ADR-0023 §9.1):
// HMAC over the user_deletions row id + purpose + expiry, keyed the same way
// EmailVerificationService keys its code hashes (API_CRYPTO_KEY). Nothing is
// stored — unlike the 6-digit codes there is no guessable secret to protect,
// and single use is enforced by the row's own state transition (confirm only
// promotes awaiting_confirmation → pending, restore only pending → restored;
// both are atomic conditional updates), so a replayed token always finds the
// state already consumed.
@Injectable()
export class DeletionTokenService {
    private readonly key: Buffer

    constructor(config: ConfigService) {
        const raw = config.get<string>('API_CRYPTO_KEY')?.trim()
        this.key = raw
            ? Buffer.from(raw, 'base64')
            : Buffer.from('manyfold-deletion-token')
    }

    mint(
        purpose: DeletionTokenPurpose,
        deletionId: string,
        expiresAt: Date
    ): string {
        const payload = `${deletionId}.${purpose}.${expiresAt.getTime()}`
        return `${payload}.${this.sign(payload)}`
    }

    // The row id the token is bound to, or null for anything malformed,
    // mis-purposed, expired, or tampered with. Callers still own the row
    // lookup and the state check — this only proves WE minted the link and
    // it is still within its window.
    verify(purpose: DeletionTokenPurpose, token: string): string | null {
        const parts = (token ?? '').split('.')
        if (parts.length !== 4) return null
        const [deletionId, tokenPurpose, expiryRaw, signature] = parts
        if (!deletionId || tokenPurpose !== purpose) return null
        const expiresAt = Number(expiryRaw)
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
        const payload = `${deletionId}.${tokenPurpose}.${expiryRaw}`
        const expected = Buffer.from(this.sign(payload))
        const provided = Buffer.from(signature)
        if (provided.length !== expected.length) return null
        if (!timingSafeEqual(provided, expected)) return null
        return deletionId
    }

    private sign(payload: string): string {
        return createHmac('sha256', this.key).update(payload).digest('hex')
    }
}
