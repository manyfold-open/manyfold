import { Injectable } from '@nestjs/common'
import { CryptoService } from '@/modules/secrets/crypto.service'

// Stateless A2A peer ticket (replaces the DB `a2a-ephemeral` bearer, §6.3). The
// caller runtime gets one signed per peer call; the inbound /rpc path decrypts
// it, binds the caller agent from the payload, and re-checks the grant (the
// ticket is freshness, the grant is authority). Tamper-proof + self-expiring
// via AES-256-GCM over API_CRYPTO_KEY — same construction as the §7.3 consent
// token, so no new key, table, or migration.
const TICKET_PREFIX = 'mfa2a_'
const TICKET_TTL_MS = 15 * 60 * 1000

export interface A2aTicketPayload {
    callerAgentId: string
    targetAgentId: string
    userId: string
    exp: number
}

// Distinguishes a malformed/tampered ticket from an expired one so the HTTP
// layer can map both to 401 while the cause stays inspectable in logs/tests.
export type A2aTicketErrorReason = 'corrupt' | 'expired'

export class A2aTicketError extends Error {
    constructor(readonly reason: A2aTicketErrorReason) {
        super(`a2a ticket ${reason}`)
        this.name = 'A2aTicketError'
    }
}

@Injectable()
export class A2aTicketService {
    constructor(private readonly crypto: CryptoService) {}

    // Mints a ticket for one caller→target delegation. exp is now+15min; the
    // caller surfaces it to the runtime so it can refresh before expiry.
    sign(args: {
        callerAgentId: string
        targetAgentId: string
        userId: string
    }): { ticket: string; exp: number } {
        const exp = Date.now() + TICKET_TTL_MS
        const payload: A2aTicketPayload = {
            callerAgentId: args.callerAgentId,
            targetAgentId: args.targetAgentId,
            userId: args.userId,
            exp
        }
        const enc = this.crypto.encrypt(JSON.stringify(payload))
        const packed = Buffer.from(JSON.stringify(enc)).toString('base64url')
        return { ticket: `${TICKET_PREFIX}${packed}`, exp }
    }

    isA2aTicket(token: string): boolean {
        return token.startsWith(TICKET_PREFIX)
    }

    verify(token: string): A2aTicketPayload {
        let payload: A2aTicketPayload
        try {
            const packed = token.slice(TICKET_PREFIX.length)
            const enc = JSON.parse(
                Buffer.from(packed, 'base64url').toString('utf8')
            )
            payload = JSON.parse(this.crypto.decrypt(enc)) as A2aTicketPayload
        } catch {
            throw new A2aTicketError('corrupt')
        }
        if (
            !payload ||
            typeof payload.callerAgentId !== 'string' ||
            typeof payload.targetAgentId !== 'string' ||
            typeof payload.userId !== 'string' ||
            typeof payload.exp !== 'number'
        )
            throw new A2aTicketError('corrupt')
        if (Date.now() > payload.exp) throw new A2aTicketError('expired')
        return payload
    }
}
