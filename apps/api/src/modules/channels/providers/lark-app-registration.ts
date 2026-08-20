import type { LarkAppRegion } from '@manyfold/shared'
import { gzipSync } from 'node:zlib'
import { channelProviderJsonRequest } from './channel-http'

const REGISTRATION_PATH = '/oauth/v1/app/registration'
const DEFAULT_POLL_INTERVAL_SEC = 5
const DEFAULT_EXPIRE_IN_SEC = 3600

const ACCOUNTS_BASE_URLS: Record<LarkAppRegion, string> = {
    feishu: 'https://accounts.feishu.cn',
    lark: 'https://accounts.larksuite.com'
}

export const LARK_APP_REGISTRATION_SCOPES = [
    'im:message.p2p_msg:readonly',
    'im:message.group_at_msg:readonly',
    'im:message:send_as_bot',
    'im:resource',
    'im:message:readonly',
    'im:message.group_msg',
    'im:message.reactions:write_only',
    'contact:user.base:readonly',
    'cardkit:card:write'
] as const

export const LARK_APP_REGISTRATION_EVENTS = [
    'im.message.receive_v1'
] as const

export const LARK_APP_REGISTRATION_CALLBACKS = [
    'card.action.trigger'
] as const

interface InitResponse {
    supported_auth_methods?: unknown
}

interface BeginResponse {
    device_code?: unknown
    verification_uri_complete?: unknown
    user_code?: unknown
    interval?: unknown
    expires_in?: unknown
    expire_in?: unknown
}

interface PollResponse {
    client_id?: unknown
    client_secret?: unknown
    user_info?: {
        open_id?: unknown
        tenant_brand?: unknown
    }
    error?: unknown
    error_description?: unknown
}

export interface LarkAppRegistrationBeginResult {
    deviceCode: string
    verificationUriComplete: string
    userCode: string
    intervalSec: number
    expireInSec: number
}

export type LarkAppRegistrationPollResult =
    | {
          status: 'success'
          appId: string
          appSecret: string
          openId: string | null
          tenantBrand: LarkAppRegion | null
      }
    | { status: 'pending' }
    | { status: 'slow_down' }
    | { status: 'switch_domain' }
    | { status: 'denied' }
    | { status: 'expired' }
    | { status: 'error'; message: string }

// The official registration flow always begins on the Feishu accounts
// domain, for Lark tenants too: the QR points at the Feishu launcher, and
// when a Lark-tenant account scans, the Feishu poll reports
// tenant_brand=lark, after which only polling switches to
// accounts.larksuite.com with the same device_code. Beginning directly on
// the Lark domain breaks scan-to-create (#331).
export const initAppRegistration = async (): Promise<void> => {
    const res = await postRegistration<InitResponse>('feishu', {
        action: 'init'
    })
    if (!res.ok)
        throw new Error(registrationFailure('init', res.status, res.text))
    const methods = res.json?.supported_auth_methods
    if (!Array.isArray(methods) || !methods.includes('client_secret'))
        throw new Error(
            'Lark app registration does not support client_secret auth'
        )
}

export const beginAppRegistration =
    async (): Promise<LarkAppRegistrationBeginResult> => {
        const res = await postRegistration<BeginResponse>('feishu', {
            action: 'begin',
            archetype: 'PersonalAgent',
            auth_method: 'client_secret',
            request_user_info: 'open_id'
        })
        if (!res.ok)
            throw new Error(registrationFailure('begin', res.status, res.text))
        const body = res.json
        if (
            !body ||
            typeof body.device_code !== 'string' ||
            typeof body.verification_uri_complete !== 'string' ||
            typeof body.user_code !== 'string'
        )
            throw new Error('Lark app registration begin returned invalid data')
        return {
            deviceCode: body.device_code,
            verificationUriComplete: body.verification_uri_complete,
            userCode: body.user_code,
            intervalSec: positiveSeconds(
                body.interval,
                DEFAULT_POLL_INTERVAL_SEC
            ),
            expireInSec: positiveSeconds(
                body.expires_in ?? body.expire_in,
                DEFAULT_EXPIRE_IN_SEC
            )
        }
    }

export const buildQrUrl = (uri: string, botName: string): string => {
    const url = new URL(uri)
    url.searchParams.set('from', 'sdk')
    url.searchParams.set('tp', 'sdk')
    url.searchParams.set('source', 'manyfold')
    url.searchParams.set('name', botName)
    url.searchParams.set('desc', 'Created by Manyfold')
    url.searchParams.set(
        'addons',
        gzipSync(
            Buffer.from(
                JSON.stringify({
                    scopes: { tenant: LARK_APP_REGISTRATION_SCOPES },
                    events: {
                        items: { tenant: LARK_APP_REGISTRATION_EVENTS }
                    },
                    callbacks: { items: LARK_APP_REGISTRATION_CALLBACKS }
                }),
                'utf8'
            )
        ).toString('base64url')
    )
    return url.toString()
}

export const pollAppRegistrationOnce = async (
    region: LarkAppRegion,
    deviceCode: string
): Promise<LarkAppRegistrationPollResult> => {
    const res = await postRegistration<PollResponse>(region, {
        action: 'poll',
        device_code: deviceCode
    })
    if (res.status >= 500)
        throw new Error(registrationFailure('poll', res.status, res.text))
    const body = res.json
    if (!body)
        return {
            status: 'error',
            message: registrationFailure('poll', res.status, res.text)
        }

    const tenantBrand = parseRegion(body.user_info?.tenant_brand)
    if (region === 'feishu' && tenantBrand === 'lark')
        return { status: 'switch_domain' }

    if (
        typeof body.client_id === 'string' &&
        typeof body.client_secret === 'string'
    )
        return {
            status: 'success',
            appId: body.client_id,
            appSecret: body.client_secret,
            openId:
                typeof body.user_info?.open_id === 'string'
                    ? body.user_info.open_id
                    : null,
            tenantBrand
        }

    switch (body.error) {
        case 'authorization_pending':
            return { status: 'pending' }
        case 'slow_down':
            return { status: 'slow_down' }
        case 'access_denied':
            return { status: 'denied' }
        case 'expired_token':
            return { status: 'expired' }
        default:
            return {
                status: 'error',
                message:
                    typeof body.error === 'string'
                        ? `${body.error}: ${typeof body.error_description === 'string' ? body.error_description : 'unknown'}`
                        : registrationFailure('poll', res.status, res.text)
            }
    }
}

const postRegistration = <T>(
    region: LarkAppRegion,
    body: Record<string, string>
) =>
    channelProviderJsonRequest<T>({
        provider: 'lark',
        operation: `app registration ${body.action}`,
        url: `${ACCOUNTS_BASE_URLS[region]}${REGISTRATION_PATH}`,
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(body).toString()
        }
    })

const positiveSeconds = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : fallback

const parseRegion = (value: unknown): LarkAppRegion | null =>
    value === 'feishu' || value === 'lark' ? value : null

const registrationFailure = (
    operation: string,
    status: number,
    text: string
): string =>
    `Lark app registration ${operation} failed with HTTP ${status}${text ? `: ${text}` : ''}`
