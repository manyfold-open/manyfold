import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { zipSync } from 'fflate'
import {
    LIBRARY_SKILL_CONTENT_FILENAME,
    MAX_LIBRARY_SKILL_FILE_BYTES,
    shouldIgnoreLibrarySkillPath
} from '@manyfold/shared'
import { UsageError } from '@/usage-error'

// A skill folder on this machine as the .skill archive the library imports.

export interface PackedSkill {
    archive: Uint8Array<ArrayBuffer>
    // `<folder>.skill`: the name the API falls back to without a frontmatter
    // name.
    filename: string
    files: number
    // Left out for their size, which an import would drop anyway.
    tooLarge: string[]
}

export const packSkillDir = async (dir: string): Promise<PackedSkill> => {
    const root = resolve(dir)
    const entries: Record<string, Uint8Array> = {}
    const tooLarge: string[] = []
    const walk = async (at: string): Promise<void> => {
        for (const entry of await readdir(at, { withFileTypes: true })) {
            const full = join(at, entry.name)
            const path = relative(root, full).split(sep).join('/')
            if (shouldIgnoreLibrarySkillPath(path)) continue
            if (entry.isDirectory()) await walk(full)
            else if (entry.isFile()) {
                if ((await stat(full)).size > MAX_LIBRARY_SKILL_FILE_BYTES)
                    tooLarge.push(path)
                else entries[path] = new Uint8Array(await readFile(full))
            }
        }
    }
    await walk(root)
    if (!entries[LIBRARY_SKILL_CONTENT_FILENAME])
        throw new UsageError(
            `${dir} has no ${LIBRARY_SKILL_CONTENT_FILENAME} at its top; a skill folder holds its ${LIBRARY_SKILL_CONTENT_FILENAME} there`
        )
    return {
        archive: new Uint8Array(zipSync(entries)),
        filename: `${basename(root)}.skill`,
        files: Object.keys(entries).length,
        tooLarge
    }
}

// The `name:` of a SKILL.md's frontmatter, if it has one.
export const frontmatterName = (content: string): string | undefined => {
    const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(content.trimStart())
    const line = block?.[1].match(/^name:[ \t]*(.+?)[ \t]*$/m)?.[1]
    const name = line?.replace(/^(["'])(.*)\1$/, '$2').trim()
    return name ? name : undefined
}
