// Library skill file limits and path rules. The single source of truth lives
// here so the web editor can validate before the api enforces the same rules.
export const LIBRARY_SKILL_CONTENT_FILENAME = 'SKILL.md'
export const MAX_LIBRARY_SKILL_FILE_BYTES = 1024 * 1024
export const MAX_LIBRARY_SKILL_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_LIBRARY_SKILL_FILE_COUNT = 128

export const LIBRARY_SKILL_FILE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,511}$/

const IGNORED_BASENAMES = /^(license|licence|notice)(\.[a-z]+)?$/i

// What an imported skill leaves out, from an archive or a local folder:
// hidden files and folders, macOS archive debris, license files, and a
// nested SKILL.md (another skill's content, not a file of this one).
export const shouldIgnoreLibrarySkillPath = (path: string): boolean => {
    const segments = path.split('/')
    if (segments.some((segment) => segment.startsWith('.'))) return true
    if (segments.some((segment) => segment === '__MACOSX')) return true
    const basename = segments[segments.length - 1]
    if (IGNORED_BASENAMES.test(basename)) return true
    return (
        path !== LIBRARY_SKILL_CONTENT_FILENAME &&
        basename.toLowerCase() === LIBRARY_SKILL_CONTENT_FILENAME.toLowerCase()
    )
}

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
