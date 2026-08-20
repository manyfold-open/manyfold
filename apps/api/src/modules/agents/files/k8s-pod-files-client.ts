import * as posix from 'node:path/posix'
import {
    BadGatewayException,
    ForbiddenException,
    NotFoundException,
    PayloadTooLargeException
} from '@nestjs/common'
import type { FsEntry, FsEntryType } from '@manyfold/sprites'
import type { PodExec } from '@/modules/k8s/pod-exec'
import { containmentPrelude, isContainmentExit } from '@manyfold/sprites'
import { mimeFromPath } from '@/modules/agents/files/k8s-files-client'

const LIST_TIMEOUT_MS = 30_000
const STAT_TIMEOUT_MS = 30_000
const READ_TIMEOUT_MS = 90_000
const WRITE_TIMEOUT_MS = 90_000
const MUTATE_TIMEOUT_MS = 30_000

// pod-exec ships the whole file base64-encoded through a single exec, so these
// are hard caps rather than tuning knobs; the roots response advertises them.
export const POD_EXEC_READ_MAX_BYTES = 50 * 1024 * 1024
export const POD_EXEC_WRITE_MAX_BYTES = 5 * 1024 * 1024
const READ_MAX_BYTES = POD_EXEC_READ_MAX_BYTES
const WRITE_MAX_BYTES = POD_EXEC_WRITE_MAX_BYTES

const shellEscape = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

const mapFindType = (kind: string): FsEntryType => {
    switch (kind) {
        case 'f':
            return 'file'
        case 'd':
            return 'dir'
        case 'l':
            return 'symlink'
        default:
            return 'other'
    }
}

const mapStatKind = (kind: string): FsEntryType => {
    const lower = kind.trim().toLowerCase()
    if (lower === 'directory') return 'dir'
    if (lower === 'regular file' || lower === 'regular empty file')
        return 'file'
    if (lower === 'symbolic link') return 'symlink'
    return 'other'
}

const sortEntries = (entries: FsEntry[]): FsEntry[] => {
    entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
    })
    return entries
}

const decodeBase64 = (stdout: string): Buffer => {
    return Buffer.from(stdout.replace(/\s+/g, ''), 'base64')
}

const guardBlankPath = (absPath: string): string => {
    const trimmed = absPath.trim()
    if (!trimmed || trimmed === '/')
        throw new ForbiddenException(
            `pod-exec files refuses path ${JSON.stringify(absPath)}`
        )
    return trimmed
}

export class K8sPodFilesClient {
    // containRoot enables the ADR-0013 symlink containment guard; the file-root
    // path comes from the caller because this client is also used for internal
    // platform paths that are not root-scoped
    constructor(
        private readonly podExec: PodExec,
        private readonly containRoot?: string
    ) {}

    private guard(...targets: string[]): string {
        return this.containRoot
            ? `${containmentPrelude(this.containRoot, targets)}\n`
            : ''
    }

    private assertContained(exitCode: number, absPath: string): void {
        if (isContainmentExit(exitCode))
            throw new ForbiddenException(`path escapes file root: ${absPath}`)
    }

    async list(absPath: string): Promise<FsEntry[]> {
        const q = shellEscape(absPath)
        const script = `${this.guard(absPath)}if [ ! -d ${q} ]; then exit 7; fi; find ${q} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%f\\n' 2>/dev/null; exit 0`
        const result = await this.podExec.run({
            cmd: ['bash', '-c', script],
            timeoutMs: LIST_TIMEOUT_MS
        })
        this.assertContained(result.exitCode, absPath)
        if (result.exitCode === 7)
            throw new NotFoundException(
                `pod-exec list: directory not found: ${absPath}`
            )
        if (result.exitCode !== 0)
            throw new BadGatewayException(
                `pod-exec list ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
        const entries: FsEntry[] = []
        for (const line of result.stdout.split('\n')) {
            if (!line) continue
            const parts = line.split('\t')
            if (parts.length < 5) continue
            const [kind, sizeStr, mtimeStr, mode, ...nameParts] = parts
            const name = nameParts.join('\t')
            const size = Number.parseInt(sizeStr, 10)
            const mtime = Math.floor(Number.parseFloat(mtimeStr))
            if (!name || !Number.isFinite(size) || !Number.isFinite(mtime))
                continue
            entries.push({
                name,
                type: mapFindType(kind),
                size,
                mtime,
                mode
            })
        }
        return sortEntries(entries)
    }

    async stat(
        absPath: string
    ): Promise<{ entry: FsEntry; contentType: string } | null> {
        const q = shellEscape(absPath)
        const script = [
            `${this.guard(absPath)}if [ ! -e ${q} ]; then exit 2; fi`,
            `stat -c '%F\t%s\t%Y\t%a' ${q} 2>/dev/null || stat -f '%HT\t%z\t%m\t%Lp' ${q}`
        ].join('; ')
        const result = await this.podExec.run({
            cmd: ['bash', '-c', script],
            timeoutMs: STAT_TIMEOUT_MS
        })
        this.assertContained(result.exitCode, absPath)
        if (result.exitCode === 2) return null
        if (result.exitCode !== 0)
            throw new BadGatewayException(
                `pod-exec stat ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
        const line = result.stdout.split('\n').find((l) => l.length > 0)
        if (!line) return null
        const parts = line.split('\t')
        if (parts.length < 4) return null
        const [kindRaw, sizeStr, mtimeStr, mode] = parts
        const size = Number.parseInt(sizeStr, 10)
        const mtime = Math.floor(Number.parseFloat(mtimeStr))
        if (!Number.isFinite(size) || !Number.isFinite(mtime)) return null
        const entry: FsEntry = {
            name: posix.basename(absPath),
            type: mapStatKind(kindRaw),
            size,
            mtime,
            mode
        }
        return { entry, contentType: mimeFromPath(absPath) }
    }

    async read(absPath: string): Promise<{
        stream: AsyncIterable<Uint8Array>
        size: number
        contentType: string
    } | null> {
        const q = shellEscape(absPath)
        const script = [
            `${this.guard(absPath)}if [ ! -f ${q} ]; then exit 2; fi`,
            `size=$(stat -c %s ${q} 2>/dev/null || stat -f %z ${q})`,
            `if [ "$size" -gt ${READ_MAX_BYTES} ]; then exit 3; fi`,
            `base64 -w0 < ${q} 2>/dev/null || base64 < ${q}`
        ].join('; ')
        const result = await this.podExec.run({
            cmd: ['bash', '-c', script],
            timeoutMs: READ_TIMEOUT_MS
        })
        this.assertContained(result.exitCode, absPath)
        if (result.exitCode === 2) return null
        if (result.exitCode === 3)
            throw new PayloadTooLargeException(
                `${absPath} exceeds ${READ_MAX_BYTES} bytes`
            )
        if (result.exitCode !== 0)
            throw new BadGatewayException(
                `pod-exec read ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
        const buf = decodeBase64(result.stdout)
        const size = buf.byteLength
        const stream: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]: async function* () {
                yield new Uint8Array(buf)
            }
        }
        return {
            stream,
            size,
            contentType: mimeFromPath(absPath)
        }
    }

    async write(absPath: string, body: Buffer): Promise<void> {
        if (body.byteLength > WRITE_MAX_BYTES)
            throw new PayloadTooLargeException(
                `pod-exec write ${absPath} exceeds ${WRITE_MAX_BYTES} bytes`
            )
        const trimmed = guardBlankPath(absPath)
        const q = shellEscape(trimmed)
        const dir = shellEscape(posix.dirname(trimmed))
        const script = `mkdir -p ${dir} && ${this.guard(trimmed)}base64 -d > ${q}`
        const stdin = body.toString('base64')
        const result = await this.podExec.run({
            cmd: ['bash', '-c', script],
            timeoutMs: WRITE_TIMEOUT_MS,
            stdin
        })
        this.assertContained(result.exitCode, trimmed)
        if (result.exitCode !== 0)
            throw new BadGatewayException(
                `pod-exec write ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
    }

    async mkdir(absPath: string): Promise<void> {
        const trimmed = guardBlankPath(absPath)
        const q = shellEscape(trimmed)
        const result = await this.podExec.run({
            cmd: ['bash', '-c', `${this.guard(trimmed)}mkdir -p ${q}`],
            timeoutMs: MUTATE_TIMEOUT_MS
        })
        this.assertContained(result.exitCode, trimmed)
        if (result.exitCode !== 0)
            throw new BadGatewayException(
                `pod-exec mkdir ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
    }

    async mv(src: string, dst: string): Promise<void> {
        const from = guardBlankPath(src)
        const to = guardBlankPath(dst)
        const qs = shellEscape(from)
        const qd = shellEscape(to)
        const result = await this.podExec.run({
            cmd: [
                'bash',
                '-c',
                `${this.guard(from, to)}mkdir -p "$(dirname ${qd})" && mv -n -- ${qs} ${qd}`
            ],
            timeoutMs: MUTATE_TIMEOUT_MS
        })
        this.assertContained(result.exitCode, `${from} -> ${to}`)
        if (result.exitCode !== 0)
            throw new BadGatewayException(
                `pod-exec mv ${src} -> ${dst} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
    }

    async rm(absPath: string, recursive: boolean): Promise<void> {
        const trimmed = guardBlankPath(absPath)
        const q = shellEscape(trimmed)
        const flags = recursive ? '-rf' : '-f'
        const result = await this.podExec.run({
            cmd: ['bash', '-c', `${this.guard(trimmed)}rm ${flags} -- ${q}`],
            timeoutMs: MUTATE_TIMEOUT_MS
        })
        this.assertContained(result.exitCode, trimmed)
        if (result.exitCode !== 0)
            throw new BadGatewayException(
                `pod-exec rm ${absPath} exited ${result.exitCode}: ${result.stderr.slice(0, 256)}`
            )
    }
}
