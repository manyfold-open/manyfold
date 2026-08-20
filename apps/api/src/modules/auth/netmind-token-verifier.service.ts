import {
    BadGatewayException,
    Injectable,
    UnauthorizedException
} from '@nestjs/common'
import type { ExternalAuthIdentity } from './auth-principal'
import { AuthSettingsService } from './auth-settings.service'

const TIMEOUT_MS = 5000

// The NetMind loginToken is bad / expired / revoked — the caller's problem (401).
export class NetmindAuthError extends Error {}

// NetMind is unreachable or broke its response contract — not the user's fault (502).
export class NetmindUpstreamError extends Error {}

@Injectable()
export class NetmindTokenVerifierService {
    constructor(private readonly authSettings: AuthSettingsService) {}

    // NetMind JWTs can't be verified offline (the signing secret embeds a
    // per-user loginToken that rotates), so verification is a live call to an
    // authenticated NetMind endpoint. Following Arena/NarraNexus we use
    // POST /user/balance and treat a returned user object as proof of validity.
    // The base URL comes from the admin-configured NetMind provider settings.
    async verify(loginToken: string): Promise<ExternalAuthIdentity> {
        const netmind = await this.authSettings.getNetmindSettings()
        if (!netmind?.enabled || !netmind.authApi)
            throw new NetmindUpstreamError('NetMind login is not enabled')
        const baseUrl = netmind.authApi.replace(/\/+$/, '')

        let response: Response
        try {
            response = await fetch(`${baseUrl}/user/balance`, {
                method: 'POST',
                headers: {
                    // NetMind convention: the auth header is literally named
                    // `token` with a Bearer prefix, NOT Authorization.
                    token: `Bearer ${loginToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            })
        } catch (err) {
            throw new NetmindUpstreamError(
                `NetMind auth API unreachable: ${(err as Error).message}`
            )
        }

        let body: unknown = null
        try {
            body = await response.json()
        } catch {
            body = null
        }

        // NetMind signals a rejected token with {success:false} even on some
        // non-2xx statuses (a non-NetMind token yields 500 carrying it), so this
        // is checked before the status-code fallbacks to map it to 401 not 502.
        if (isRecord(body) && body.success === false)
            throw new NetmindAuthError('NetMind rejected the token')
        if (response.status >= 500)
            throw new NetmindUpstreamError(
                `NetMind auth API returned ${response.status}`
            )
        if (response.status >= 400)
            throw new NetmindAuthError('NetMind rejected the token')
        if (!isRecord(body))
            throw new NetmindUpstreamError('NetMind auth API returned non-JSON')

        const data = isRecord(body.data) ? body.data : {}
        const user = isRecord(data.user) ? data.user : {}
        return extractIdentity(user)
    }
}

const extractIdentity = (
    user: Record<string, unknown>
): ExternalAuthIdentity => {
    const email = trimLower(user.email)
    const subject = trimString(user.userSystemCode ?? user.user_system_code)
    if (!email || !subject)
        throw new NetmindUpstreamError(
            'NetMind /user/balance response missing identity fields'
        )
    return { provider: 'netmind', subject, email }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

const trimString = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''

const trimLower = (value: unknown): string =>
    typeof value === 'string' ? value.trim().toLowerCase() : ''

// Map the verifier's two-valued errors to HTTP. Controllers use this in a
// `.catch()` so a bad token surfaces as 401 and an upstream / contract failure
// as 502 — never disguised as the other.
export const netmindHttpError = (err: unknown): never => {
    if (err instanceof NetmindAuthError)
        throw new UnauthorizedException({
            code: 'auth.netmind_invalid_token',
            message: 'invalid NetMind token'
        })
    if (err instanceof NetmindUpstreamError)
        throw new BadGatewayException({
            code: 'auth.netmind_unavailable',
            message: 'NetMind auth service unavailable, try again'
        })
    throw err
}