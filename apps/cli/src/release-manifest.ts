import type { CliChannel } from '@/channel'
import type {
    UpdateArch,
    UpdateArchiveFormat,
    UpdateReleaseOs,
    UpdateTarget
} from '@/self-update'

const MANIFEST_SCHEMA = 1
export const MAX_MANIFEST_BYTES = 128 * 1024
const MANIFEST_FETCH_TIMEOUT_MS = 10_000

export type UpdateTargetKey = `${UpdateReleaseOs}-${UpdateArch}`

export interface ReleaseArtifact {
    url: string
    sha256: string
    size: number
    format: UpdateArchiveFormat
    binary: 'mf' | 'mf.exe'
}

export interface ReleaseManifest {
    schema: typeof MANIFEST_SCHEMA
    channel: CliChannel
    version: string
    // The canonical identity of a build. Consecutive dev builds share a base
    // version, so the commit — not semver — is what orders the dev channel.
    commit: string
    commitShort: string
    buildTime: string
    publishedAt: string
    tag: string
    notesUrl?: string
    artifacts: Partial<Record<UpdateTargetKey, ReleaseArtifact>>
}

export const targetKey = (target: UpdateTarget): UpdateTargetKey =>
    `${target.os}-${target.arch}`

const SHA256_RE = /^[0-9a-f]{64}$/

const fail = (source: string, why: string): never => {
    throw new Error(`invalid release manifest at ${source}: ${why}`)
}

const parseArtifact = (
    raw: unknown,
    key: string,
    source: string
): ReleaseArtifact => {
    if (typeof raw !== 'object' || raw === null)
        fail(source, `artifact ${key} is not an object`)
    const a = raw as Record<string, unknown>
    if (typeof a.url !== 'string' || !a.url)
        fail(source, `artifact ${key} has no url`)
    // https only. The manifest is fetched over TLS from a trusted origin and
    // every downloaded byte is checked against the sha256 it carries, so the
    // artifact host itself is deliberately not pinned — that is what lets the
    // storage move without reissuing binaries.
    let parsed: URL
    try {
        parsed = new URL(a.url as string)
    } catch {
        return fail(source, `artifact ${key} url is not a URL`)
    }
    if (parsed.protocol !== 'https:')
        fail(source, `artifact ${key} url is not https`)
    if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256))
        fail(source, `artifact ${key} sha256 is not 64 lowercase hex chars`)
    if (a.format !== 'tar.gz' && a.format !== 'zip')
        fail(source, `artifact ${key} has an unknown format`)
    if (a.binary !== 'mf' && a.binary !== 'mf.exe')
        fail(source, `artifact ${key} has an unknown binary name`)
    const size = typeof a.size === 'number' && a.size > 0 ? a.size : 0
    return {
        url: a.url as string,
        sha256: a.sha256 as string,
        size,
        format: a.format as UpdateArchiveFormat,
        binary: a.binary as 'mf' | 'mf.exe'
    }
}

export const parseReleaseManifest = (
    raw: unknown,
    source: string
): ReleaseManifest => {
    if (typeof raw !== 'object' || raw === null)
        fail(source, 'body is not an object')
    const m = raw as Record<string, unknown>
    if (m.schema !== MANIFEST_SCHEMA)
        fail(source, `unsupported schema ${String(m.schema)}`)
    const channel = m.channel
    if (channel !== 'stable' && channel !== 'dev')
        fail(source, `unknown channel ${String(channel)}`)
    for (const field of ['version', 'commit', 'tag'] as const)
        if (typeof m[field] !== 'string' || !(m[field] as string))
            fail(source, `${field} is missing`)
    if (typeof m.artifacts !== 'object' || m.artifacts === null)
        fail(source, 'artifacts is missing')
    const artifacts: Partial<Record<UpdateTargetKey, ReleaseArtifact>> = {}
    for (const [key, value] of Object.entries(
        m.artifacts as Record<string, unknown>
    ))
        artifacts[key as UpdateTargetKey] = parseArtifact(value, key, source)
    const commit = m.commit as string
    return {
        schema: MANIFEST_SCHEMA,
        channel: channel as CliChannel,
        version: m.version as string,
        commit,
        commitShort:
            typeof m.commitShort === 'string' && m.commitShort
                ? m.commitShort
                : commit.slice(0, 7),
        buildTime: typeof m.buildTime === 'string' ? m.buildTime : '',
        publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : '',
        tag: m.tag as string,
        ...(typeof m.notesUrl === 'string' && m.notesUrl
            ? { notesUrl: m.notesUrl }
            : {}),
        artifacts
    }
}

export const manifestArtifact = (
    manifest: ReleaseManifest,
    target: UpdateTarget
): ReleaseArtifact => {
    const key = targetKey(target)
    const artifact = manifest.artifacts[key]
    if (!artifact)
        throw new Error(
            `the ${manifest.channel} channel has no ${key} build for ${manifest.version}`
        )
    return artifact
}

export const fetchReleaseManifest = async (
    url: string,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<ReleaseManifest> => {
    const doFetch = opts.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(
        () => controller.abort(),
        opts.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS
    )
    try {
        const res = await doFetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
        const text = await res.text()
        if (text.length > MAX_MANIFEST_BYTES)
            fail(url, `body exceeds ${MAX_MANIFEST_BYTES} bytes`)
        let json: unknown
        try {
            json = JSON.parse(text)
        } catch {
            return fail(url, 'body is not JSON')
        }
        return parseReleaseManifest(json, url)
    } finally {
        clearTimeout(timer)
    }
}
