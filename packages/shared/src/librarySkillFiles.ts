// Library skill file limits and path rules. The single source of truth lives
// here so the web editor can validate before the api enforces the same rules.
export const LIBRARY_SKILL_CONTENT_FILENAME = 'SKILL.md'
export const MAX_LIBRARY_SKILL_FILE_BYTES = 1024 * 1024
export const MAX_LIBRARY_SKILL_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_LIBRARY_SKILL_FILE_COUNT = 128

export const LIBRARY_SKILL_FILE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,511}$/

export type LibraryFilePathValidationCode = 'invalid' | 'reserved'

export type LibraryFilePathValidationResult =
    | { valid: true; value: string }
    | { valid: false; code: LibraryFilePathValidationCode }

export const validateLibraryFilePath = (
    input: string
): LibraryFilePathValidationResult => {
    const value = input.trim().replace(/^\.\//, '')
    if (
        !LIBRARY_SKILL_FILE_PATH_RE.test(value) ||
        value.includes('..') ||
        value.includes('//') ||
        value.endsWith('/')
    )
        return { valid: false, code: 'invalid' }
    if (value.toLowerCase() === LIBRARY_SKILL_CONTENT_FILENAME.toLowerCase())
        return { valid: false, code: 'reserved' }
    return { valid: true, value }
}
