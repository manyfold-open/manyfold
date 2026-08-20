import { randomBytes, randomUUID } from 'node:crypto'
import {
    CHANNEL_PROVIDER_HTTP_TIMEOUT_MS,
    channelProviderJsonRequest
} from './channel-http'

// Tencent iLink bot gateway wire client (personal WeChat). Protocol mirrors
// Tencent's official @tencent-weixin/openclaw-weixin plugin; validated
// end-to-end by pocs/weixin-ilink-echo in the harness repo.
export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000
export const WEIXIN_STALE_SESSION_ERRCODE = -14
export const WEIXIN_RATE_LIMIT_RET = -2
// QR login always begins against the fixed gateway; a successful scan may then
// hand the poller an IDC-specific host (see scaned_but_redirect).
export const WEIXIN_QR_BOT_TYPE = '3'

const WEIXIN_CHANNEL_VERSION = '1.0.0'
const WEIXIN_BOT_AGENT = 'Manyfold/1.0'

export const WeixinItemType = {
    TEXT: 1,
    IMAGE: 2,
    VOICE: 3,
    FILE: 4,
    VIDEO: 5
} as const

// getuploadurl media_type (distinct from the item-type numbering above)
export const WeixinUploadMediaType = {
    IMAGE: 1,
    VIDEO: 2,
    FILE: 3,
    VOICE: 4
} as const

export const WeixinMessageType = {
    USER: 1,
    BOT: 2
} as const

export interface WeixinCdnMedia {
    encrypt_query_param?: string
    aes_key?: string
    full_url?: string
}

export interface WeixinMessageItem {
    type?: number
    msg_id?: string
    ref_msg?: { message_item?: WeixinMessageItem; title?: string }
    text_item?: { text?: string }
    image_item?: {
        media?: WeixinCdnMedia
        // raw hex AES key, preferred over media.aes_key for inbound images
        aeskey?: string
    }
    voice_item?: { text?: string }
    file_item?: { file_name?: string; media?: WeixinCdnMedia }
    video_item?: { media?: WeixinCdnMedia }
}

export interface WeixinMessage {
    seq?: number
    message_id?: number
    from_user_id?: string
    to_user_id?: string
    client_id?: string
    create_time_ms?: number
    session_id?: string
    group_id?: string
    message_type?: number
    message_state?: number
    item_list?: WeixinMessageItem[]
    context_token?: string
}

export interface WeixinApiEnvelope {
    ret?: number
    errcode?: number
    errmsg?: string
}

export interface WeixinGetUpdatesResponse extends WeixinApiEnvelope {
    msgs?: WeixinMessage[]
    get_updates_buf?: string
    longpolling_timeout_ms?: number
}

export interface WeixinGetConfigResponse extends WeixinApiEnvelope {
    typing_ticket?: string
}

export interface WeixinRequestOptions {
    baseUrl: string
    token: string
    signal?: AbortSignal
    timeoutMs?: number
}

export const weixinApiError = (resp: WeixinApiEnvelope): boolean =>
    (resp.ret !== undefined && resp.ret !== 0) ||
    (resp.errcode !== undefined && resp.errcode !== 0)

export const weixinStaleSession = (resp: WeixinApiEnvelope): boolean =>
    resp.ret === WEIXIN_STALE_SESSION_ERRCODE ||
    resp.errcode === WEIXIN_STALE_SESSION_ERRCODE

export const weixinRateLimited = (resp: WeixinApiEnvelope): boolean =>
    resp.ret === WEIXIN_RATE_LIMIT_RET ||
    resp.errcode === WEIXIN_RATE_LIMIT_RET

// X-WECHAT-UIN: random uint32 -> decimal string -> base64, per request.
const randomWechatUin = (): string =>
    Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString(
        'base64'
    )

const baseInfo = (): Record<string, string> => ({
    channel_version: WEIXIN_CHANNEL_VERSION,
    bot_agent: WEIXIN_BOT_AGENT
})

const weixinPost = async <T extends WeixinApiEnvelope>(
    opts: WeixinRequestOptions,
    endpoint: string,
    operation: string,
    body: Record<string, unknown>
): Promise<T> => {
    const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`
    const res = await channelProviderJsonRequest<T>({
        provider: 'weixin',
        operation,
        url: new URL(endpoint, base).toString(),
        timeoutMs: opts.timeoutMs ?? CHANNEL_PROVIDER_HTTP_TIMEOUT_MS,
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                AuthorizationType: 'ilink_bot_token',
                Authorization: `Bearer ${opts.token}`,
                'X-WECHAT-UIN': randomWechatUin(),
                'iLink-App-Id': 'bot',
                'iLink-App-ClientVersion': '65536'
            },
            body: JSON.stringify({ ...body, base_info: baseInfo() }),
            ...(opts.signal ? { signal: opts.signal } : {})
        }
    })
    if (!res.ok)
        throw new Error(
            `weixin ${operation} HTTP ${res.status}: ${res.text.slice(0, 200)}`
        )
    if (!res.json) throw new Error(`weixin ${operation} returned no JSON`)
    return res.json
}

const isTimeoutError = (err: unknown): boolean =>
    err instanceof Error && / timed out after \d+ms$/.test(err.message)

// Long-poll for updates. A client-side timeout is the normal no-news outcome
// and returns an empty envelope so the caller simply re-polls.
export const weixinGetUpdates = async (
    opts: WeixinRequestOptions,
    getUpdatesBuf: string
): Promise<WeixinGetUpdatesResponse> => {
    const timeoutMs = opts.timeoutMs ?? WEIXIN_LONG_POLL_TIMEOUT_MS + 5_000
    try {
        return await weixinPost<WeixinGetUpdatesResponse>(
            { ...opts, timeoutMs },
            'ilink/bot/getupdates',
            'getUpdates',
            { get_updates_buf: getUpdatesBuf }
        )
    } catch (err) {
        if (isTimeoutError(err))
            return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
        throw err
    }
}

export const weixinSendMessage = async (
    opts: WeixinRequestOptions,
    params: { to: string; text: string; contextToken?: string | null }
): Promise<{ resp: WeixinApiEnvelope; clientId: string }> => {
    const clientId = `manyfold-${randomUUID()}`
    const resp = await weixinPost<WeixinApiEnvelope>(
        opts,
        'ilink/bot/sendmessage',
        'sendMessage',
        {
            msg: {
                from_user_id: '',
                to_user_id: params.to,
                client_id: clientId,
                message_type: WeixinMessageType.BOT,
                message_state: 2,
                item_list: [
                    { type: WeixinItemType.TEXT, text_item: { text: params.text } }
                ],
                ...(params.contextToken
                    ? { context_token: params.contextToken }
                    : {})
            }
        }
    )
    return { resp, clientId }
}

export interface WeixinUploadUrlResponse extends WeixinApiEnvelope {
    upload_full_url?: string
    upload_param?: string
}

export const weixinGetUploadUrl = async (
    opts: WeixinRequestOptions,
    params: {
        filekey: string
        mediaType: number
        toUserId: string
        rawSize: number
        rawMd5: string
        cipherSize: number
        aesKeyHex: string
    }
): Promise<WeixinUploadUrlResponse> =>
    weixinPost<WeixinUploadUrlResponse>(
        opts,
        'ilink/bot/getuploadurl',
        'getUploadUrl',
        {
            filekey: params.filekey,
            media_type: params.mediaType,
            to_user_id: params.toUserId,
            rawsize: params.rawSize,
            rawfilemd5: params.rawMd5,
            filesize: params.cipherSize,
            no_need_thumb: true,
            aeskey: params.aesKeyHex
        }
    )

// Send a pre-built media item (image/file) to a peer.
export const weixinSendMediaItem = async (
    opts: WeixinRequestOptions,
    params: {
        to: string
        item: WeixinMessageItem
        contextToken?: string | null
    }
): Promise<{ resp: WeixinApiEnvelope; clientId: string }> => {
    const clientId = `manyfold-${randomUUID()}`
    const resp = await weixinPost<WeixinApiEnvelope>(
        opts,
        'ilink/bot/sendmessage',
        'sendMediaMessage',
        {
            msg: {
                from_user_id: '',
                to_user_id: params.to,
                client_id: clientId,
                message_type: WeixinMessageType.BOT,
                message_state: 2,
                item_list: [params.item],
                ...(params.contextToken
                    ? { context_token: params.contextToken }
                    : {})
            }
        }
    )
    return { resp, clientId }
}

export const weixinGetConfig = async (
    opts: WeixinRequestOptions,
    params: { userId: string; contextToken?: string | null }
): Promise<WeixinGetConfigResponse> =>
    weixinPost<WeixinGetConfigResponse>(
        opts,
        'ilink/bot/getconfig',
        'getConfig',
        {
            ilink_user_id: params.userId,
            ...(params.contextToken
                ? { context_token: params.contextToken }
                : {})
        }
    )

export const weixinSendTyping = async (
    opts: WeixinRequestOptions,
    params: { userId: string; typingTicket: string; status: 1 | 2 }
): Promise<WeixinApiEnvelope> =>
    weixinPost<WeixinApiEnvelope>(
        opts,
        'ilink/bot/sendtyping',
        'sendTyping',
        {
            ilink_user_id: params.userId,
            typing_ticket: params.typingTicket,
            status: params.status
        }
    )

export const weixinNotifyStart = async (
    opts: WeixinRequestOptions
): Promise<WeixinApiEnvelope> =>
    weixinPost<WeixinApiEnvelope>(
        opts,
        'ilink/bot/msg/notifystart',
        'notifyStart',
        {}
    )

export const weixinNotifyStop = async (
    opts: WeixinRequestOptions
): Promise<WeixinApiEnvelope> =>
    weixinPost<WeixinApiEnvelope>(
        opts,
        'ilink/bot/msg/notifystop',
        'notifyStop',
        {}
    )

// ---------------------------------------------------------------------------
// QR login (pre-auth: these calls carry no bot token)
// ---------------------------------------------------------------------------

export interface WeixinQrCodeResponse {
    qrcode?: string
    qrcode_img_content?: string
}

export type WeixinQrStatus =
    | 'wait'
    | 'scaned'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect'
    | 'expired'
    | 'confirmed'

export interface WeixinQrStatusResponse {
    status?: WeixinQrStatus
    bot_token?: string
    ilink_bot_id?: string
    baseurl?: string
    ilink_user_id?: string
    redirect_host?: string
}

const weixinCommonHeaders = (): Record<string, string> => ({
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '65536'
})

export const weixinFetchQrCode = async (
    baseUrl: string
): Promise<WeixinQrCodeResponse> => {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const res = await channelProviderJsonRequest<WeixinQrCodeResponse>({
        provider: 'weixin',
        operation: 'getBotQrCode',
        url: new URL(
            `ilink/bot/get_bot_qrcode?bot_type=${WEIXIN_QR_BOT_TYPE}`,
            base
        ).toString(),
        timeoutMs: CHANNEL_PROVIDER_HTTP_TIMEOUT_MS,
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...weixinCommonHeaders()
            },
            body: JSON.stringify({ local_token_list: [] })
        }
    })
    if (!res.ok || !res.json)
        throw new Error(`weixin getBotQrCode HTTP ${res.status}`)
    return res.json
}

// Advance the scan state machine once. `verifyCode` is the pairing number the
// user typed, forwarded on the next poll. A short client timeout returns `wait`
// so the caller can re-poll cheaply (this is not a long-poll).
export const weixinPollQrStatus = async (
    baseUrl: string,
    qrcode: string,
    verifyCode?: string | null,
    timeoutMs = 8_000
): Promise<WeixinQrStatusResponse> => {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
    try {
        const res = await channelProviderJsonRequest<WeixinQrStatusResponse>({
            provider: 'weixin',
            operation: 'getQrCodeStatus',
            url: new URL(endpoint, base).toString(),
            timeoutMs,
            init: { method: 'GET', headers: weixinCommonHeaders() }
        })
        if (!res.ok || !res.json)
            throw new Error(`weixin getQrCodeStatus HTTP ${res.status}`)
        return res.json
    } catch (err) {
        if (err instanceof Error && / timed out after \d+ms$/.test(err.message))
            return { status: 'wait' }
        throw err
    }
}