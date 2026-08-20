const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const OBJECT_ID_RE = /^([a-z][a-z0-9]{1,4})_([a-z2-7]{26})$/

export const objectIdPrefixes = Object.freeze({
    user: 'usr',
    agent: 'agt',
    agentBackup: 'abk',
    agentBackupRestore: 'abr',
    agentCredential: 'acr',
    agentRuntime: 'art',
    agentRuntimeToken: 'rtk',
    agentPermission: 'agp',
    permissionConsentRequest: 'pcr',
    a2aContext: 'aac',
    a2aTask: 'aat',
    a2aAgentGrant: 'a2g',
    a2aConnectSession: 'acs',
    apiToken: 'pat',
    automation: 'aut',
    automationRun: 'aur',
    catalogCategory: 'cat',
    channel: 'chn',
    larkAppRegistration: 'lreg',
    weixinRegistration: 'wxr',
    channelSession: 'chs',
    chatMessageSource: 'cms',
    chatSession: 'cts',
    chatSessionShare: 'css',
    chatUpload: 'cup',
    daemonHost: 'dh',
    emailVerification: 'evf',
    frameworkEnumCatalogEntry: 'fec',
    frameworkModelCatalogEntry: 'fmc',
    k8sCluster: 'clus',
    librarySkill: 'skl',
    librarySkillFile: 'skf',
    librarySkillShare: 'lss',
    mcpCatalogEntry: 'mcp',
    notificationWebhook: 'nwh',
    oauthState: 'oas',
    runtimeInvite: 'rti',
    runtimeInviteRedemption: 'rir',
    sandboxHost: 'sbx',
    scopedModelPrice: 'smp',
    skillRepo: 'skr',
    spritesAccount: 'spa',
    userConnection: 'ucn',
    userExternalAgentProvider: 'uep',
    userMcpServer: 'ums',
    userModelProvider: 'ump',
    userSession: 'ses',
    userSkill: 'usk'
} as const)

export type ObjectIdResource = keyof typeof objectIdPrefixes

export interface ParsedObjectId {
    prefix: string
    resource: string | null
    unique: string
}

const objectIdResourceByPrefix = buildResourceByPrefix()

// Composition layers (the cloud edition) register their resource prefixes at
// module load. Prefixes are a compatibility contract (§ObjectId): collisions
// throw loudly, and registration never overrides a core entry.
const extraPrefixByResource: Record<string, string> = {}
const extraResourceByPrefix: Record<string, string> = {}

export function registerObjectIdPrefixes(
    extra: Record<string, string>
): void {
    for (const [resource, prefix] of Object.entries(extra)) {
        const existing =
            (objectIdPrefixes as Record<string, string>)[resource] ??
            extraPrefixByResource[resource]
        if (existing && existing !== prefix)
            throw new Error(
                `object id resource "${resource}" already registered`
            )
        const claimed =
            objectIdResourceByPrefix[prefix] ?? extraResourceByPrefix[prefix]
        if (claimed && claimed !== resource)
            throw new Error(`duplicate object id prefix "${prefix}"`)
        extraPrefixByResource[resource] = prefix
        extraResourceByPrefix[prefix] = resource
    }
}

export function createObjectId(
    resource: ObjectIdResource | (string & {})
): string {
    const prefix =
        (objectIdPrefixes as Record<string, string>)[resource] ??
        extraPrefixByResource[resource]
    if (!prefix)
        throw new Error(`unknown object id resource "${resource}"`)
    return `${prefix}_${base32Encode(uuidV7Bytes())}`
}

export function parseObjectId(id: string): ParsedObjectId | null {
    const match = OBJECT_ID_RE.exec(id)
    if (!match) return null
    const [, prefix, unique] = match
    return {
        prefix,
        resource:
            objectIdResourceByPrefix[prefix] ??
            extraResourceByPrefix[prefix] ??
            null,
        unique
    }
}

export function isObjectId(
    id: string,
    resource?: ObjectIdResource | (string & {})
): boolean {
    const parsed = parseObjectId(id)
    if (!parsed) return false
    if (!resource) return true
    return parsed.resource === resource
}

function buildResourceByPrefix(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [resource, prefix] of Object.entries(objectIdPrefixes)) {
        if (result[prefix])
            throw new Error(
                `duplicate object id prefix "${prefix}" for ${resource}`
            )
        result[prefix] = resource
    }
    return Object.freeze(result)
}

function uuidV7Bytes(): Uint8Array {
    const bytes = new Uint8Array(16)
    getCrypto().getRandomValues(bytes)

    let timestamp = BigInt(Date.now())
    for (let i = 5; i >= 0; i -= 1) {
        bytes[i] = Number(timestamp & 0xffn)
        timestamp >>= 8n
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x70
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return bytes
}

function getCrypto(): Crypto {
    if (!globalThis.crypto?.getRandomValues)
        throw new Error('global crypto.getRandomValues is not available')
    return globalThis.crypto
}

function base32Encode(bytes: Uint8Array): string {
    let output = ''
    let buffer = 0
    let bitsLeft = 0

    for (const byte of bytes) {
        buffer = (buffer << 8) | byte
        bitsLeft += 8

        while (bitsLeft >= 5) {
            output += BASE32_ALPHABET[(buffer >>> (bitsLeft - 5)) & 31]
            bitsLeft -= 5
        }

        buffer = bitsLeft === 0 ? 0 : buffer & ((1 << bitsLeft) - 1)
    }

    if (bitsLeft > 0) output += BASE32_ALPHABET[(buffer << (5 - bitsLeft)) & 31]

    return output
}
