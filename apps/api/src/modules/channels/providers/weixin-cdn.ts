import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// WeChat C2C CDN media handling (AES-128-ECB + PKCS7), ported from Tencent's
// official @tencent-weixin/openclaw-weixin plugin (MIT).

const WEIXIN_CDN_DOWNLOAD_TIMEOUT_MS = 30_000

// Hosts the CDN downloader may reach. Guards against a poisoned descriptor
// pointing full_url at an arbitrary host (SSRF).
const CDN_HOST_SUFFIXES = [
    'weixin.qq.com',
    'wechat.com',
    'qlogo.cn',
    'qpic.cn'
]

export interface WeixinCdnDescriptor {
    // encrypt_query_param, used with cdnBaseUrl when full_url is absent
    q?: string
    // full download URL when the gateway supplies one
    u?: string
    // media.aes_key (base64 of raw-16 or hex-32)
    k?: string
    // image_item.aeskey (raw hex string)
    ak?: string
    name: string
    contentType: string
}

const SENTINEL_PREFIX = 'weixin-cdn:'

export const encodeCdnDescriptor = (d: WeixinCdnDescriptor): string =>
    `${SENTINEL_PREFIX}${Buffer.from(JSON.stringify(d), 'utf8').toString('base64url')}`

export const decodeCdnDescriptor = (
    url: string
): WeixinCdnDescriptor | null => {
    if (!url.startsWith(SENTINEL_PREFIX)) return null
    try {
        return JSON.parse(
            Buffer.from(url.slice(SENTINEL_PREFIX.length), 'base64url').toString(
                'utf8'
            )
        ) as WeixinCdnDescriptor
    } catch {
        return null
    }
}

// media.aes_key comes as base64 of either raw 16 bytes (images) or a 32-char
// hex string (file/voice/video); image_item.aeskey is a raw hex string.
export const parseAesKey = (params: {
    aesKeyBase64?: string
    aesKeyHex?: string
}): Buffer => {
    if (params.aesKeyHex) {
        const buf = Buffer.from(params.aesKeyHex, 'hex')
        if (buf.length === 16) return buf
    }
    if (params.aesKeyBase64) {
        const decoded = Buffer.from(params.aesKeyBase64, 'base64')
        if (decoded.length === 16) return decoded
        const ascii = decoded.toString('ascii')
        if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii))
            return Buffer.from(ascii, 'hex')
    }
    throw new Error('weixin CDN aes key is not a 16-byte or hex-32 value')
}

const decryptAesEcb = (ciphertext: Buffer, key: Buffer): Buffer => {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

const encryptAesEcb = (plaintext: Buffer, key: Buffer): Buffer => {
    const cipher = createCipheriv('aes-128-ecb', key, null)
    return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

// PKCS7 pads to a full extra block when already aligned, so ciphertext is
// always ceil((n+1)/16)*16 bytes.
export const aesEcbPaddedSize = (plaintextSize: number): number =>
    Math.ceil((plaintextSize + 1) / 16) * 16

export interface WeixinUploadPlan {
    filekey: string
    aesKeyHex: string
    rawSize: number
    rawMd5: string
    cipherSize: number
    ciphertext: Buffer
}

// Encrypt the payload and derive the getuploadurl parameters. The aes key is
// random per upload; media.aes_key on the wire must be base64(hex(key)) or the
// recipient shows a grey block.
export const prepareWeixinUpload = (plaintext: Buffer): WeixinUploadPlan => {
    const aesKey = randomBytes(16)
    const aesKeyHex = aesKey.toString('hex')
    return {
        filekey: randomBytes(16).toString('hex'),
        aesKeyHex,
        rawSize: plaintext.length,
        rawMd5: createHash('md5').update(plaintext).digest('hex'),
        cipherSize: aesEcbPaddedSize(plaintext.length),
        ciphertext: encryptAesEcb(plaintext, aesKey)
    }
}

export const weixinMediaAesKeyForWire = (aesKeyHex: string): string =>
    Buffer.from(aesKeyHex, 'utf8').toString('base64')

// POST the ciphertext to the CDN and return the download param the recipient
// needs (x-encrypted-param). Host-allowlisted like the download path.
export const uploadWeixinCdnCiphertext = async (
    uploadUrl: string,
    ciphertext: Buffer
): Promise<string> => {
    if (!hostAllowed(uploadUrl))
        throw new Error(`weixin CDN upload host not allowed: ${uploadUrl}`)
    const controller = new AbortController()
    const timer = setTimeout(
        () => controller.abort(),
        WEIXIN_CDN_DOWNLOAD_TIMEOUT_MS
    )
    try {
        const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: new Uint8Array(ciphertext).buffer,
            signal: controller.signal
        })
        if (!res.ok)
            throw new Error(
                `weixin CDN upload failed (${res.status}): ${res.headers.get('x-error-message') ?? ''}`
            )
        const param = res.headers.get('x-encrypted-param')
        if (!param)
            throw new Error('weixin CDN upload response missing x-encrypted-param')
        return param
    } finally {
        clearTimeout(timer)
    }
}

const hostAllowed = (url: string): boolean => {
    let host: string
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
            return false
        host = parsed.hostname.toLowerCase()
    } catch {
        return false
    }
    return CDN_HOST_SUFFIXES.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    )
}

// Sniff an image mime from magic bytes; defaults to jpeg.
export const sniffImageMime = (bytes: Buffer): string => {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'image/jpeg'
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    )
        return 'image/png'
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
        return 'image/gif'
    if (
        bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP'
    )
        return 'image/webp'
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)
        return 'image/bmp'
    return 'image/jpeg'
}

const readCappedBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) {
        const buf = Buffer.from(await response.arrayBuffer())
        if (buf.length > maxBytes)
            throw new Error(`weixin CDN file exceeds ${maxBytes} bytes`)
        return buf
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new Error(`weixin CDN file exceeds ${maxBytes} bytes`)
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
}

// Download and AES-128-ECB decrypt a CDN media file (post AES the padding is
// PKCS7, handled by node's decipher). Enforces maxBytes on the *ciphertext*
// read and the host allowlist on whatever URL is used.
export const downloadWeixinCdnMedia = async (
    descriptor: WeixinCdnDescriptor,
    cdnBaseUrl: string,
    maxBytes: number
): Promise<{ name: string; contentType: string; bytes: Buffer }> => {
    const key = parseAesKey({
        aesKeyBase64: descriptor.k,
        aesKeyHex: descriptor.ak
    })
    const url = descriptor.u
        ? descriptor.u
        : descriptor.q
          ? `${cdnBaseUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(descriptor.q)}`
          : null
    if (!url) throw new Error('weixin CDN descriptor has no URL')
    if (!hostAllowed(url))
        throw new Error(`weixin CDN host not allowed: ${url}`)

    const controller = new AbortController()
    const timer = setTimeout(
        () => controller.abort(),
        WEIXIN_CDN_DOWNLOAD_TIMEOUT_MS
    )
    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal
        })
        if (!response.ok)
            throw new Error(
                `weixin CDN download failed (${response.status})`
            )
        const encrypted = await readCappedBody(response, maxBytes)
        const bytes = decryptAesEcb(encrypted, key)
        const contentType = descriptor.contentType.startsWith('image/')
            ? sniffImageMime(bytes)
            : descriptor.contentType
        return { name: descriptor.name, contentType, bytes }
    } finally {
        clearTimeout(timer)
    }
}
