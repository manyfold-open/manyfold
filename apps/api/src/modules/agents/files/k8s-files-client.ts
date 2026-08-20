import {
    K8S_HOME_BASE,
    agentBaseUrl,
    codingAgentHomeRootForWorkspacePath
} from '@manyfold/shared'
import * as posix from 'node:path/posix'
import {
    BadGatewayException,
    ForbiddenException,
    InternalServerErrorException,
    Logger,
    NotFoundException
} from '@nestjs/common'
import type { Agent, FileRoot } from '@manyfold/db'
import type { FsEntry, FsEntryType } from '@manyfold/sprites'
import { envString } from '@/common/config-alias'

const log = new Logger('k8sFiles')
const DEBUG = envString(['MF_FILES_DEBUG', 'NCA_FILES_DEBUG']) === '1'
const K8S_CODING_PVC_ROOT = `${K8S_HOME_BASE}/.manyfold`

export interface K8sDufsPathMapping {
    displayPath: string
    dufsPath: string
}

export interface K8sFilesTarget {
    runtimeId: string
    primaryAgentId: string
    ingressHost: string
    pathMapping: K8sDufsPathMapping
}

const HOME_ROOT_MAPPINGS: Record<
    string,
    { framework: Agent['framework']; displayPath: string; dufsPath: string }
> = {
    'claude-home': {
        framework: 'claude-code',
        displayPath: `${K8S_HOME_BASE}/.claude`,
        dufsPath: '/state/claude'
    },
    'codex-home': {
        framework: 'codex',
        displayPath: `${K8S_HOME_BASE}/.codex`,
        dufsPath: '/state/codex'
    },
    'gemini-home': {
        framework: 'gemini-cli',
        displayPath: `${K8S_HOME_BASE}/.gemini`,
        dufsPath: '/state/gemini'
    }
}

const normalizeAbsPath = (path: string): string => {
    const normalized = posix.normalize(path)
    return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

const normalizeDufsPath = (path: string): string => {
    const withSlash = path.startsWith('/') ? path : `/${path}`
    const normalized = posix.normalize(withSlash)
    return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

const isCodingK8sAgent = (agent: Agent): boolean =>
    agent.framework === 'claude-code' ||
    agent.framework === 'codex' ||
    agent.framework === 'gemini-cli'

const servedPvcRootForAgent = (agent: Agent): string => {
    if (!isCodingK8sAgent(agent)) return normalizeAbsPath(agent.mountPath)
    const stored = agent.workspacePath ?? agent.mountPath
    return (
        codingAgentHomeRootForWorkspacePath(normalizeAbsPath(stored)) ??
        K8S_CODING_PVC_ROOT
    )
}

export const k8sDufsPathMappingForRoot = (
    agent: Agent,
    root: FileRoot
): K8sDufsPathMapping => {
    const displayPath = normalizeAbsPath(root.path)
    const homeMapping = HOME_ROOT_MAPPINGS[root.id]
    if (
        homeMapping &&
        agent.framework === homeMapping.framework &&
        displayPath === homeMapping.displayPath
    )
        return {
            displayPath,
            dufsPath: homeMapping.dufsPath
        }

    const pvcRoot = servedPvcRootForAgent(agent)
    if (displayPath === pvcRoot)
        return {
            displayPath,
            dufsPath: '/'
        }
    if (displayPath.startsWith(pvcRoot + '/'))
        return {
            displayPath,
            dufsPath: normalizeDufsPath(displayPath.slice(pvcRoot.length))
        }

    throw new InternalServerErrorException(
        `k8s file root ${root.id} (${displayPath}) is not served by DUFS root ${pvcRoot}`
    )
}

const filesBaseUrlPath = (primaryAgentId: string): string =>
    `/api/agents/${primaryAgentId}/files`

const baseUrl = (target: K8sFilesTarget): string => {
    if (!target.ingressHost)
        throw new InternalServerErrorException(
            'k8s runtime missing ingressHost'
        )
    if (!target.primaryAgentId)
        throw new InternalServerErrorException(
            'k8s runtime missing primaryAgentId'
        )
    return agentBaseUrl(
        target.ingressHost,
        filesBaseUrlPath(target.primaryAgentId)
    )
}

const absToDufs = (target: K8sFilesTarget, absPath: string): string => {
    const displayRoot = normalizeAbsPath(target.pathMapping.displayPath)
    const dufsRoot = normalizeDufsPath(target.pathMapping.dufsPath)
    const normalizedAbs = normalizeAbsPath(absPath)
    if (normalizedAbs === displayRoot) return dufsRoot
    if (!normalizedAbs.startsWith(displayRoot + '/'))
        throw new ForbiddenException(`path escapes k8s file root: ${absPath}`)
    return normalizeDufsPath(
        `${dufsRoot}${normalizedAbs.slice(displayRoot.length)}`
    )
}

const isDisplayRoot = (target: K8sFilesTarget, absPath: string): boolean => {
    return (
        normalizeAbsPath(absPath) ===
        normalizeAbsPath(target.pathMapping.displayPath)
    )
}

const encodeDufsPath = (dufsPath: string): string => {
    const normalized = dufsPath.startsWith('/') ? dufsPath : `/${dufsPath}`
    return normalized
        .split('/')
        .map((seg) => (seg ? encodeURIComponent(seg) : ''))
        .join('/')
}

const dufsUrl = (target: K8sFilesTarget, dufsPath: string): string =>
    `${baseUrl(target)}${encodeDufsPath(dufsPath)}`

const throwForStatus = async (
    res: Response,
    op: string,
    dufsPath: string
): Promise<never> => {
    const body = await res.text().catch(() => '')
    if (res.status === 404)
        throw new NotFoundException(`no such path: ${dufsPath}`)
    if (res.status === 403)
        throw new ForbiddenException(`dufs ${op} 403: ${body.slice(0, 256)}`)
    throw new BadGatewayException(
        `dufs ${op} ${res.status}: ${body.slice(0, 256)}`
    )
}

type DufsFetchInit = RequestInit & { timeoutMs?: number }

const dufsFetch = (url: string, init: DufsFetchInit = {}): Promise<Response> =>
    k8sFetch(url, init)

const dufsTypeToFsType = (pathType: string): FsEntryType => {
    if (pathType === 'Dir') return 'dir'
    if (pathType === 'SymlinkDir' || pathType === 'SymlinkFile')
        return 'symlink'
    if (pathType === 'File') return 'file'
    return 'other'
}

interface DufsPathItem {
    path_type: string
    name: string
    mtime: number
    size: number
}

interface DufsIndexResponse {
    href: string
    kind: string
    paths?: DufsPathItem[]
}

const toFsEntry = (item: DufsPathItem, name = item.name): FsEntry => ({
    name,
    type: dufsTypeToFsType(item.path_type),
    size: item.size,
    mtime: Number.isFinite(item.mtime) ? Math.floor(item.mtime / 1_000) : 0,
    mode:
        item.path_type === 'Dir' || item.path_type === 'SymlinkDir'
            ? '755'
            : '644'
})

export const mimeFromPath = (path: string): string => {
    const ext = path.toLowerCase().split('.').pop() ?? ''
    const map: Record<string, string> = {
        txt: 'text/plain',
        md: 'text/markdown',
        markdown: 'text/markdown',
        html: 'text/html',
        htm: 'text/html',
        css: 'text/css',
        js: 'text/javascript',
        mjs: 'text/javascript',
        ts: 'application/typescript',
        tsx: 'application/typescript',
        json: 'application/json',
        jsonl: 'application/x-ndjson',
        ndjson: 'application/x-ndjson',
        yml: 'application/yaml',
        yaml: 'application/yaml',
        toml: 'application/toml',
        xml: 'application/xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        pdf: 'application/pdf',
        zip: 'application/zip',
        py: 'text/x-python',
        sh: 'application/x-sh',
        env: 'text/plain',
        log: 'text/plain'
    }
    return map[ext] ?? 'application/octet-stream'
}

const basename = (path: string): string => {
    const parts = path.split('/').filter(Boolean)
    return parts.at(-1) ?? ''
}

const davTagText = (xml: string, tag: string): string | null => {
    const match = new RegExp(`<D:${tag}>([\\s\\S]*?)</D:${tag}>`).exec(xml)
    return match?.[1]?.trim() ?? null
}

const parseDavStat = (xml: string, dufsPath: string): FsEntry => {
    if (!xml.includes('<D:response'))
        throw new BadGatewayException(
            `dufs stat returned invalid WebDAV XML: ${xml.slice(0, 256)}`
        )
    const isDir = /<D:collection\s*\/?>/.test(xml)
    const size = Number.parseInt(davTagText(xml, 'getcontentlength') ?? '0', 10)
    const mtimeMs = Date.parse(davTagText(xml, 'getlastmodified') ?? '')
    return {
        name: dufsPath === '/' ? '' : basename(dufsPath),
        type: isDir ? 'dir' : 'file',
        size: Number.isFinite(size) ? size : 0,
        mtime: Number.isFinite(mtimeMs) ? Math.floor(mtimeMs / 1_000) : 0,
        mode: isDir ? '755' : '644'
    }
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000
const STREAM_FETCH_TIMEOUT_MS = 60_000

const k8sFetch = async (
    url: string,
    init: DufsFetchInit = {}
): Promise<Response> => {
    const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal, ...rest } = init
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const composed = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal
    try {
        return await fetch(url, { ...rest, signal: composed })
    } catch (err) {
        const e = err as Error
        if (e.name === 'TimeoutError')
            throw new BadGatewayException(
                `k8s files upstream timed out after ${timeoutMs}ms: ${url}`
            )
        if (e.name === 'AbortError')
            throw new BadGatewayException(`k8s files request aborted: ${url}`)
        throw new BadGatewayException(
            `k8s files upstream unreachable: ${e.message}`
        )
    }
}

export const k8sListDir = async (
    agent: Agent,
    target: K8sFilesTarget,
    absPath: string
): Promise<FsEntry[]> => {
    const dufsPath = absToDufs(target, absPath)
    const url = `${dufsUrl(target, dufsPath)}?json`
    const res = await dufsFetch(url)
    if (!res.ok) await throwForStatus(res, 'list', dufsPath)
    const text = await res.text()
    if (DEBUG)
        log.debug(
            `list agent=${agent.id} runtime=${target.runtimeId} abs=${absPath} dufs=${dufsPath} url=${url} -> ${text.slice(0, 256)}`
        )
    let body: DufsIndexResponse
    try {
        body = JSON.parse(text) as DufsIndexResponse
    } catch {
        throw new BadGatewayException(
            `dufs list returned non-JSON: ${text.slice(0, 256)}`
        )
    }
    const entries = (body.paths ?? []).map((item) =>
        toFsEntry(item, basename(item.name))
    )
    entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
    })
    return entries
}

export const k8sStatFile = async (
    target: K8sFilesTarget,
    absPath: string
): Promise<{ entry: FsEntry; contentType: string } | null> => {
    const dufsPath = absToDufs(target, absPath)
    const res = await dufsFetch(dufsUrl(target, dufsPath), {
        method: 'PROPFIND',
        headers: { Depth: '0' }
    })
    if (res.status === 404) return null
    if (!res.ok) await throwForStatus(res, 'stat', dufsPath)
    return {
        entry: parseDavStat(
            await res.text(),
            isDisplayRoot(target, absPath) ? '/' : dufsPath
        ),
        contentType: mimeFromPath(dufsPath)
    }
}

export interface K8sReadResult {
    stream: AsyncIterable<Uint8Array>
    size: number
    contentType: string
}

export const k8sReadFile = async (
    target: K8sFilesTarget,
    absPath: string
): Promise<K8sReadResult | null> => {
    const stat = await k8sStatFile(target, absPath)
    if (!stat) return null
    if (stat.entry.type === 'dir') return null
    const dufsPath = absToDufs(target, absPath)
    const res = await dufsFetch(dufsUrl(target, dufsPath), {
        timeoutMs: STREAM_FETCH_TIMEOUT_MS
    })
    if (res.status === 404) return null
    if (!res.ok || !res.body) await throwForStatus(res, 'read', dufsPath)
    const body = res.body as unknown as AsyncIterable<Uint8Array>
    return {
        stream: body,
        size: stat.entry.size,
        contentType: stat.contentType
    }
}

// Writes to a sibling temp path and MOVEs it into place, so a failed or
// cancelled upload leaves whatever was already at absPath untouched.
export const k8sWriteFile = async (
    target: K8sFilesTarget,
    absPath: string,
    body: AsyncIterable<Uint8Array> | Uint8Array
): Promise<void> => {
    const partPath = `${absPath}.mf-part`
    try {
        await k8sWriteStream(target, partPath, body)
    } catch (err) {
        await k8sRm(target, partPath).catch(() => {})
        throw err
    }
    try {
        await k8sMv(target, partPath, absPath)
    } catch (err) {
        await k8sRm(target, partPath).catch(() => {})
        throw err
    }
}

export const k8sWriteStream = async (
    target: K8sFilesTarget,
    absPath: string,
    body: AsyncIterable<Uint8Array> | Uint8Array
): Promise<void> => {
    const dufsPath = absToDufs(target, absPath)
    const res = await dufsFetch(dufsUrl(target, dufsPath), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as unknown as BodyInit,
        timeoutMs: STREAM_FETCH_TIMEOUT_MS,
        duplex: 'half'
    } as DufsFetchInit & { duplex: 'half' })
    if (!res.ok) await throwForStatus(res, 'write', dufsPath)
}

export const k8sMkdir = async (
    target: K8sFilesTarget,
    absPath: string
): Promise<void> => {
    const dufsPath = absToDufs(target, absPath)
    const res = await dufsFetch(dufsUrl(target, dufsPath), {
        method: 'MKCOL'
    })
    if (res.ok) return
    if (res.status === 405) {
        const stat = await k8sStatFile(target, absPath)
        if (stat?.entry.type === 'dir') return
    }
    await throwForStatus(res, 'mkdir', dufsPath)
}

export const k8sMv = async (
    target: K8sFilesTarget,
    absFrom: string,
    absTo: string
): Promise<void> => {
    const dufsFrom = absToDufs(target, absFrom)
    const dufsTo = absToDufs(target, absTo)
    const res = await dufsFetch(dufsUrl(target, dufsFrom), {
        method: 'MOVE',
        headers: { Destination: dufsUrl(target, dufsTo) }
    })
    if (!res.ok) await throwForStatus(res, 'mv', dufsFrom)
}

export const k8sRm = async (
    target: K8sFilesTarget,
    absPath: string
): Promise<void> => {
    const dufsPath = absToDufs(target, absPath)
    const res = await dufsFetch(dufsUrl(target, dufsPath), {
        method: 'DELETE'
    })
    if (res.status === 404) return
    if (!res.ok) await throwForStatus(res, 'rm', dufsPath)
}
