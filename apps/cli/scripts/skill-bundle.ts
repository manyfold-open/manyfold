import { createHash } from 'node:crypto'
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAgentHelp } from '../src/agent-help/helpers'

export const SKILL_NAME = 'manyfold-cli-usage'
export const DEFAULT_SKILL_VERSION = '0.0.0-dev'
export const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const pluginSkillDir = resolve(
    cliDir,
    '../../plugins/manyfold/skills',
    SKILL_NAME
)
const helpDir = join(cliDir, 'src/agent-help')

export type SkillBundle = Record<string, string>

export const readSkillBundle = (dir: string): SkillBundle => {
    if (!existsSync(dir)) return {}
    const files: SkillBundle = Object.create(null)
    const visit = (relative: string): void => {
        for (const entry of readdirSync(join(dir, relative), {
            withFileTypes: true
        }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = posix.join(relative, entry.name)
            if (entry.isDirectory()) visit(path)
            else if (entry.isFile())
                files[path] = readFileSync(join(dir, path), 'utf8')
            else
                throw new Error(
                    `Skill bundle must contain regular files: ${path}`
                )
        }
    }
    visit('')
    return files
}

export const buildSkillBundle = (
    version = DEFAULT_SKILL_VERSION
): SkillBundle => {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))
        throw new Error('Skill version must be semver')
    const render = (name: string): string =>
        renderAgentHelp(readFileSync(join(helpDir, name), 'utf8')).trim() + '\n'
    const references: SkillBundle = Object.fromEntries(
        Object.entries(readSkillBundle(join(helpDir, 'references'))).map(
            ([path, content]) => [`references/${path}`, content]
        )
    )
    references['references/auth.md'] = render('auth.md')
    references['references/a2a.md'] = render('a2a.md')
    // Older deployment checks compare SKILL.md only. Carry reference changes
    // into that comparison while the full-directory check validates every byte.
    const digest = createHash('sha256')
        .update(
            JSON.stringify(
                Object.entries(references).sort(([a], [b]) =>
                    a.localeCompare(b)
                )
            )
        )
        .digest('hex')
    const description =
        'Operate Manyfold resources through mf from managed runtimes or external coding agents, delegate via A2A, and show results in the workbench when available. Not for developing Manyfold source code.'
    const frontmatter = [
        '---',
        `name: ${SKILL_NAME}`,
        `description: ${description}`,
        `version: ${version}`,
        'metadata:',
        `  references-sha256: "${digest}"`,
        '---',
        ''
    ].join('\n')
    return {
        'SKILL.md':
            frontmatter +
            render('index.md') +
            '\n' +
            render('skill-context.md'),
        ...references
    }
}

export const writeSkillBundle = (dir: string, files: SkillBundle): void => {
    rmSync(dir, { recursive: true, force: true })
    for (const [path, content] of Object.entries(files)) {
        const target = join(dir, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content)
    }
}

export const compareSkillBundles = (
    expected: SkillBundle,
    actual: SkillBundle
): string[] => {
    const paths = [
        ...new Set([...Object.keys(expected), ...Object.keys(actual)])
    ].sort()
    return paths.flatMap((path) => {
        if (!Object.hasOwn(actual, path)) return [`missing: ${path}`]
        if (!Object.hasOwn(expected, path)) return [`unexpected: ${path}`]
        return expected[path] === actual[path] ? [] : [`changed: ${path}`]
    })
}

export const skillBundleVersion = (files: SkillBundle): string => {
    const version = files['SKILL.md']?.match(/^version:\s*([^\s]+)\s*$/m)?.[1]
    if (!version) throw new Error('Skill bundle has no version')
    return version
}

export const fetchPublishedSkill = async (
    skillId: string,
    fetcher: typeof fetch = fetch
): Promise<{ files: SkillBundle; version: string; revision: string }> => {
    const parsed = /^github:([^/]+)\/([^@]+)@([^:]+):(.+)$/.exec(skillId)
    if (!parsed) throw new Error('Expected a GitHub skill ID')
    const [, owner, repo, ref, sourcePath] = parsed
    const get = async (url: string): Promise<Response> => {
        const response = await fetcher(url)
        if (!response.ok)
            throw new Error(
                `Skill fetch failed: HTTP ${response.status} ${url}`
            )
        return response
    }
    const base = `https://api.github.com/repos/${owner}/${repo}`
    const commit = (await (
        await get(`${base}/commits/${encodeURIComponent(ref)}`)
    ).json()) as { sha: string }
    const tree = (await (
        await get(`${base}/git/trees/${commit.sha}?recursive=1`)
    ).json()) as {
        truncated: boolean
        tree: Array<{ type: string; mode: string; path: string }>
    }
    if (tree.truncated) throw new Error('Cannot verify a truncated skill tree')
    const prefix = sourcePath + '/'
    const files: SkillBundle = Object.create(null)
    for (const entry of tree.tree) {
        if (entry.type !== 'blob' || !entry.path.startsWith(prefix)) continue
        if (entry.mode === '120000')
            throw new Error('Published skill contains a symlink')
        const path = entry.path.split('/').map(encodeURIComponent).join('/')
        files[entry.path.slice(prefix.length)] = await (
            await get(
                `https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${path}`
            )
        ).text()
    }
    return { files, version: skillBundleVersion(files), revision: commit.sha }
}
