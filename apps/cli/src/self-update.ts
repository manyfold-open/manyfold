import { rename, rm } from 'node:fs/promises'
import { arch as currentArch } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { isBunStandalone } from '@/standalone'

const TAR_BLOCK_BYTES = 512
const TAR_NAME_BYTES = 100
const TAR_SIZE_OFFSET = 124
const TAR_SIZE_BYTES = 12
const TAR_CHECKSUM_OFFSET = 148
const TAR_CHECKSUM_BYTES = 8
const TAR_TYPE_OFFSET = 156
const TAR_PREFIX_OFFSET = 345
const TAR_PREFIX_BYTES = 155
const MAX_UPDATE_BINARY_BYTES = 512 * 1024 * 1024

export const OLD_BINARY_SUFFIX = '.old'

export type UpdateArchiveFormat = 'tar.gz' | 'zip'
export type UpdateReleaseOs = 'linux' | 'darwin' | 'windows'
export type UpdateArch = 'x64' | 'arm64'

export interface UpdateTarget {
    os: UpdateReleaseOs
    arch: UpdateArch
    archiveFormat: UpdateArchiveFormat
    binaryName: 'mf' | 'mf.exe'
}

export const resolveUpdateTarget = (
    platform: NodeJS.Platform = process.platform,
    architecture: string = currentArch()
): UpdateTarget => {
    if (architecture !== 'x64' && architecture !== 'arm64')
        throw new Error(`unsupported arch: ${architecture}`)
    if (platform === 'win32') {
        if (architecture !== 'x64')
            throw new Error(`unsupported Windows arch: ${architecture}`)
        return {
            os: 'windows',
            arch: architecture,
            archiveFormat: 'zip',
            binaryName: 'mf.exe'
        }
    }
    if (platform !== 'linux' && platform !== 'darwin')
        throw new Error(`unsupported platform: ${platform}`)
    return {
        os: platform,
        arch: architecture,
        archiveFormat: 'tar.gz',
        binaryName: 'mf'
    }
}

const tarString = (field: Uint8Array): string => {
    const end = field.indexOf(0)
    return Buffer.from(end === -1 ? field : field.subarray(0, end))
        .toString('utf8')
        .trim()
}

const tarOctal = (field: Uint8Array, label: string): number => {
    const value = tarString(field).trim()
    if (!/^[0-7]+$/.test(value)) throw new Error(`invalid tar ${label}`)
    const parsed = Number.parseInt(value, 8)
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error(`invalid tar ${label}`)
    return parsed
}

const isZeroBlock = (block: Uint8Array): boolean =>
    block.every((byte) => byte === 0)

const verifyTarChecksum = (header: Uint8Array): void => {
    const expected = tarOctal(
        header.subarray(
            TAR_CHECKSUM_OFFSET,
            TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES
        ),
        'checksum'
    )
    let actual = 0
    for (let index = 0; index < header.length; index += 1) {
        actual +=
            index >= TAR_CHECKSUM_OFFSET &&
            index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES
                ? 0x20
                : header[index]
    }
    if (actual !== expected) throw new Error('invalid tar header checksum')
}

const extractBinaryFromTar = (
    archive: Uint8Array,
    binaryName: string
): Buffer => {
    if (
        archive.length < TAR_BLOCK_BYTES ||
        archive.length % TAR_BLOCK_BYTES !== 0
    )
        throw new Error('invalid tar archive length')
    let offset = 0
    while (offset + TAR_BLOCK_BYTES <= archive.length) {
        const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES)
        if (isZeroBlock(header)) break
        verifyTarChecksum(header)

        const name = tarString(header.subarray(0, TAR_NAME_BYTES))
        const prefix = tarString(
            header.subarray(
                TAR_PREFIX_OFFSET,
                TAR_PREFIX_OFFSET + TAR_PREFIX_BYTES
            )
        )
        const path = prefix ? `${prefix}/${name}` : name
        const size = tarOctal(
            header.subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_BYTES),
            'entry size'
        )
        const dataStart = offset + TAR_BLOCK_BYTES
        const dataEnd = dataStart + size
        if (dataEnd > archive.length) throw new Error('truncated tar entry')

        const type = header[TAR_TYPE_OFFSET]
        const regularFile = type === 0 || type === '0'.charCodeAt(0)
        if (path === binaryName && regularFile) {
            if (size === 0 || size > MAX_UPDATE_BINARY_BYTES)
                throw new Error(`invalid ${binaryName} size in tar archive`)
            return Buffer.from(archive.subarray(dataStart, dataEnd))
        }

        offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
    }
    throw new Error(`binary '${binaryName}' not found at archive root`)
}

const extractBinaryFromTarGz = (
    archive: Uint8Array,
    binaryName: string
): Buffer => {
    let tar: Buffer
    try {
        tar = gunzipSync(archive, {
            maxOutputLength: MAX_UPDATE_BINARY_BYTES * 2
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`invalid tar.gz archive: ${message}`)
    }
    return extractBinaryFromTar(tar, binaryName)
}

const extractBinaryFromZip = (
    archive: Uint8Array,
    binaryName: string
): Buffer => {
    let matches = 0
    let entries: Record<string, Uint8Array>
    try {
        entries = unzipSync(archive, {
            filter: (file) => {
                if (file.name !== binaryName) return false
                matches += 1
                return file.originalSize <= MAX_UPDATE_BINARY_BYTES
            }
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`invalid zip archive: ${message}`)
    }
    const binary = entries[binaryName]
    if (matches !== 1 || !binary || binary.byteLength === 0)
        throw new Error(`binary '${binaryName}' not found at archive root`)
    return Buffer.from(binary)
}

export const extractUpdateBinary = (
    archive: Uint8Array,
    target: UpdateTarget
): Buffer =>
    target.archiveFormat === 'zip'
        ? extractBinaryFromZip(archive, target.binaryName)
        : extractBinaryFromTarGz(archive, target.binaryName)

type RenameFile = (source: string, destination: string) => Promise<void>
type RemoveFile = (path: string) => Promise<void>

export interface ReplaceExecutableOptions {
    platform?: NodeJS.Platform
    renameFile?: RenameFile
    removeFile?: RemoveFile
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

export const replaceExecutable = async (
    newBinaryPath: string,
    execPath: string,
    options: ReplaceExecutableOptions = {}
): Promise<void> => {
    const platform = options.platform ?? process.platform
    const renameFile = options.renameFile ?? rename
    const removeFile =
        options.removeFile ?? ((path: string) => rm(path, { force: true }))

    if (platform !== 'win32') {
        await renameFile(newBinaryPath, execPath)
        return
    }

    const oldPath = `${execPath}${OLD_BINARY_SUFFIX}`
    await removeFile(oldPath).catch(() => {})
    try {
        await renameFile(execPath, oldPath)
    } catch (error) {
        throw new Error(
            `could not move the running executable aside: ${errorMessage(error)}`
        )
    }

    try {
        await renameFile(newBinaryPath, execPath)
    } catch (installError) {
        try {
            await renameFile(oldPath, execPath)
        } catch (restoreError) {
            throw new Error(
                `could not install the new executable: ${errorMessage(installError)}; restoring the previous executable also failed: ${errorMessage(restoreError)}`
            )
        }
        throw new Error(
            `could not install the new executable; the previous executable was restored: ${errorMessage(installError)}`
        )
    }
}

export interface CleanupStaleUpdateOptions {
    platform?: NodeJS.Platform
    execPath?: string
    standalone?: boolean
    removeFile?: RemoveFile
}

export const cleanupStaleUpdateArtifact = async (
    options: CleanupStaleUpdateOptions = {}
): Promise<void> => {
    const platform = options.platform ?? process.platform
    const standalone = options.standalone ?? isBunStandalone()
    if (platform !== 'win32' || !standalone) return
    const execPath = options.execPath ?? process.execPath
    const removeFile =
        options.removeFile ?? ((path: string) => rm(path, { force: true }))
    await removeFile(`${execPath}${OLD_BINARY_SUFFIX}`).catch(() => {})
}
