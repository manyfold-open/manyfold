import { execSprite } from './exec'
import { SpritesError } from './errors'
import { containmentPrelude, isContainmentExit } from './containment'
import type { SpritesClient } from './client'
import type { FsEntry, FsEntryType, SpritesLogger } from './types'

const DEFAULT_TIMEOUT_MS = 30_000

const shellEscape = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

const assertContained = (exitCode: number, absPath: string): void => {
    if (isContainmentExit(exitCode))
        throw new SpritesError(
            'permanent',
            `path escapes file root: ${absPath}`
        )
}

const mapType = (findType: string): FsEntryType => {
    switch (findType) {
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

export const spriteListDir = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger?: SpritesLogger,
    containRoot?: string
): Promise<FsEntry[]> => {
    const q = shellEscape(absPath)
    const guard = containRoot
        ? `${containmentPrelude(containRoot, [absPath])}\n`
        : ''
    const script = `${guard}if [ ! -d ${q} ]; then exit 7; fi; find ${q} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%f\\n' 2>/dev/null; exit 0`
    const result = await execSprite(
        client,
        spriteName,
        {
            cmd: ['bash', '-c', script],
            stdin: '',
            timeoutMs: DEFAULT_TIMEOUT_MS
        },
        logger
    )
    assertContained(result.exitCode, absPath)
    if (result.exitCode === 7)
        throw new SpritesError(
            'not_found',
            `spriteListDir: directory not found: ${absPath}`
        )
    if (result.exitCode !== 0)
        throw new SpritesError(
            'transient',
            `spriteListDir exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
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
        if (!name || !Number.isFinite(size) || !Number.isFinite(mtime)) continue
        entries.push({
            name,
            type: mapType(kind),
            size,
            mtime,
            mode
        })
    }
    entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
    })
    return entries
}

export const spriteMkdir = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    logger?: SpritesLogger,
    containRoot?: string
): Promise<void> => {
    const q = shellEscape(absPath)
    const script = containRoot
        ? `${containmentPrelude(containRoot, [absPath])}\nmkdir -p ${q}`
        : `mkdir -p ${q}`
    const result = await execSprite(
        client,
        spriteName,
        {
            cmd: ['bash', '-c', script],
            stdin: '',
            timeoutMs: DEFAULT_TIMEOUT_MS
        },
        logger
    )
    assertContained(result.exitCode, absPath)
    if (result.exitCode !== 0)
        throw new SpritesError(
            'transient',
            `spriteMkdir exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
}

export interface SpriteRmOptions {
    recursive?: boolean
    containRoot?: string
}

export const spriteRm = async (
    client: SpritesClient,
    spriteName: string,
    absPath: string,
    opts: SpriteRmOptions = {},
    logger?: SpritesLogger
): Promise<void> => {
    const trimmed = absPath.trim()
    if (trimmed === '' || trimmed === '/')
        throw new SpritesError(
            'permanent',
            `spriteRm refuses path ${JSON.stringify(absPath)}`
        )
    const q = shellEscape(trimmed)
    const flags = opts.recursive ? '-rf' : '-f'
    const script = opts.containRoot
        ? `${containmentPrelude(opts.containRoot, [trimmed])}\nrm ${flags} -- ${q}`
        : `rm ${flags} -- ${q}`
    const result = await execSprite(
        client,
        spriteName,
        {
            cmd: ['bash', '-c', script],
            stdin: '',
            timeoutMs: DEFAULT_TIMEOUT_MS
        },
        logger
    )
    assertContained(result.exitCode, trimmed)
    if (result.exitCode !== 0)
        throw new SpritesError(
            'transient',
            `spriteRm exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
}

export const spriteMv = async (
    client: SpritesClient,
    spriteName: string,
    src: string,
    dst: string,
    logger?: SpritesLogger,
    containRoot?: string
): Promise<void> => {
    const qs = shellEscape(src)
    const qd = shellEscape(dst)
    const guard = containRoot
        ? `${containmentPrelude(containRoot, [src, dst])}\n`
        : ''
    const result = await execSprite(
        client,
        spriteName,
        {
            cmd: [
                'bash',
                '-c',
                `${guard}mkdir -p "$(dirname ${qd})" && mv -n -- ${qs} ${qd}`
            ],
            stdin: '',
            timeoutMs: DEFAULT_TIMEOUT_MS
        },
        logger
    )
    assertContained(result.exitCode, `${src} -> ${dst}`)
    if (result.exitCode !== 0)
        throw new SpritesError(
            'transient',
            `spriteMv exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
}
