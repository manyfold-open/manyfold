import { loadBaileys } from './whatsapp-baileys'

// WhatsApp media is an end-to-end encrypted blob on Meta's CDN: the message
// only carries the pointer plus the key needed to decrypt it. There is no URL
// the bridge's anonymous fetch could use, so inbound attachments travel as an
// opaque descriptor and the provider's downloadAttachment resolves it.
const SENTINEL_PREFIX = 'whatsapp-media:'

export type WhatsappMediaKind = 'image' | 'document' | 'video' | 'audio'

export interface WhatsappMediaDescriptor {
    kind: WhatsappMediaKind
    // The subset of the Baileys media message the downloader needs. Kept as a
    // plain record so it survives the JSON round trip through event_json.
    message: Record<string, unknown>
    name: string
    contentType: string
}

export const encodeMediaDescriptor = (d: WhatsappMediaDescriptor): string =>
    `${SENTINEL_PREFIX}${Buffer.from(JSON.stringify(d), 'utf8').toString('base64url')}`

export const decodeMediaDescriptor = (
    url: string
): WhatsappMediaDescriptor | null => {
    if (!url.startsWith(SENTINEL_PREFIX)) return null
    try {
        const parsed = JSON.parse(
            Buffer.from(
                url.slice(SENTINEL_PREFIX.length),
                'base64url'
            ).toString('utf8')
        ) as WhatsappMediaDescriptor
        return parsed.message && typeof parsed.message === 'object'
            ? parsed
            : null
    } catch {
        return null
    }
}

// Baileys streams the ciphertext and decrypts as it goes, so the cap is
// enforced chunk by chunk: a lying media size can never buy more than one
// extra chunk of memory.
export const downloadWhatsappMedia = async (
    descriptor: WhatsappMediaDescriptor,
    maxBytes: number
): Promise<{ name: string; contentType: string; bytes: Buffer }> => {
    const { downloadContentFromMessage } = await loadBaileys()
    const stream = await downloadContentFromMessage(
        descriptor.message as Parameters<typeof downloadContentFromMessage>[0],
        descriptor.kind as Parameters<typeof downloadContentFromMessage>[1]
    )
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
        total += chunk.length
        if (total > maxBytes)
            throw new Error(
                `whatsapp attachment exceeds ${maxBytes} bytes`
            )
        chunks.push(chunk as Buffer)
    }
    return {
        name: descriptor.name,
        contentType: descriptor.contentType,
        bytes: Buffer.concat(chunks)
    }
}

const EXTENSION_BY_TYPE: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf'
}

// Documents carry their own fileName; images almost never do, so one is
// synthesized from the mimetype. Falls back to a bare name rather than
// guessing an extension the bytes may not match.
export const whatsappMediaName = (
    kind: WhatsappMediaKind,
    contentType: string,
    fileName?: string | null
): string => {
    const trimmed = fileName?.trim()
    if (trimmed) return trimmed
    const base = contentType.split(';')[0]?.trim() ?? ''
    const ext = EXTENSION_BY_TYPE[base]
    return ext ? `${kind}.${ext}` : kind
}
