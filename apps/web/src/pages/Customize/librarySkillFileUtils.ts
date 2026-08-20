import { MAX_LIBRARY_SKILL_FILE_BYTES } from '@manyfold/shared'

export const joinRelPath = (dir: string, name: string): string =>
    dir ? `${dir}/${name}` : name

export const baseName = (path: string): string =>
    path.split('/').filter(Boolean).at(-1) ?? path

export const utf8ByteLength = (value: string): number =>
    new TextEncoder().encode(value).length

export type SkillTextFileResult =
    | { ok: true; text: string }
    | { ok: false; code: 'binary' | 'tooLarge' }

// Mirrors the server's looksBinary (NUL byte) plus a strict UTF-8 gate:
// non-UTF-8 bytes would otherwise mojibake silently through JSON transport.
export const readSkillTextFile = async (
    file: File
): Promise<SkillTextFileResult> => {
    if (file.size > MAX_LIBRARY_SKILL_FILE_BYTES)
        return { ok: false, code: 'tooLarge' }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.includes(0)) return { ok: false, code: 'binary' }
    try {
        return {
            ok: true,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        }
    } catch {
        return { ok: false, code: 'binary' }
    }
}

export type DraftPathConflict = 'file' | 'dir' | null

// 'file' = exact duplicate (may be overwritten), 'dir' = structural clash: the
// candidate is an ancestor directory of an existing file, or would nest under
// an existing file. The server accepts both shapes but they collide on disk
// when the skill materializes.
export const draftPathConflict = (
    paths: readonly string[],
    candidate: string
): DraftPathConflict => {
    if (paths.includes(candidate)) return 'file'
    for (const path of paths) {
        if (path.startsWith(`${candidate}/`)) return 'dir'
        if (candidate.startsWith(`${path}/`)) return 'dir'
    }
    return null
}
