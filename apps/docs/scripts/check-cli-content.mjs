import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const docsDir = resolve(here, '../src/content/docs')
const changelogDir = resolve(here, '../src/content/changelog')
const cliDir = resolve(here, '../../cli')
const errors = []

const read = (path) => readFileSync(path, 'utf8')
const markdownFiles = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return markdownFiles(path)
        return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
    })

const cliVersion = JSON.parse(read(join(cliDir, 'package.json'))).version
for (const path of [
    join(docsDir, 'cli-reference.md'),
    join(docsDir, 'zh/cli-reference.md')
]) {
    if (!read(path).includes(`\`mf ${cliVersion}\``))
        errors.push(`${path} is not generated for mf ${cliVersion}`)
}

const cliChangelog = read(join(cliDir, 'CHANGELOG.md'))
for (const match of cliChangelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)) {
    const version = match[1]
    const path = join(changelogDir, `cli-v${version}.md`)
    let entry
    try {
        entry = read(path)
    } catch {
        errors.push(`${path} is missing`)
        continue
    }
    if (
        !new RegExp(
            `^version: ['"]${version.replaceAll('.', '\\.')}['"]$`,
            'm'
        ).test(entry)
    )
        errors.push(`${path} has mismatched version frontmatter`)
}

const maintainedPages = [
    'cli',
    'install',
    'profiles',
    'scripting',
    'cli-agents',
    'cli-runtimes',
    'cli-automations',
    'cli-backups',
    'cli-skills',
    'cli-usage',
    'cli-a2a',
    'cli-reference',
    'local-daemons'
]
for (const page of maintainedPages) {
    for (const path of [
        join(docsDir, `${page}.md`),
        join(docsDir, 'zh', `${page}.md`)
    ]) {
        try {
            read(path)
        } catch {
            errors.push(`${path} is missing`)
        }
    }
}

const obsolete = [
    /~\/\.manyfold\/config(?:\.<profile>)?\.json/,
    /~\/\.manyfold\/daemon\//,
    /ai\.manyfold\.daemon\.plist/,
    /mf-daemon\.service/
]
for (const path of [
    ...markdownFiles(docsDir),
    ...markdownFiles(join(cliDir, 'src/agent-help'))
]) {
    const content = read(path)
    for (const pattern of obsolete)
        if (pattern.test(content)) errors.push(`${path} contains ${pattern}`)
    // agent-help docs are concatenated verbatim into the published skill
    // bundle (apps/cli/scripts/build-skills.ts), so a stray fence does not
    // just look wrong here — it ships to every hosted agent.
    if (content.split('\n').filter((line) => line.startsWith('```')).length % 2)
        errors.push(`${path} has an unclosed code fence`)
    if (/^```[a-z]*\n\s*```/m.test(content))
        errors.push(`${path} has an empty code block`)
}

if (errors.length > 0)
    throw new Error(
        `CLI content checks failed:\n- ${errors.join('\n- ')}\n\n` +
            `To resync after a CLI version bump:\n` +
            `  pnpm --filter '@manyfold/cli^...' build\n` +
            `  pnpm --filter @manyfold/cli build:public-reference\n` +
            `  write apps/docs/src/content/changelog/cli-v${cliVersion}.md`
    )

console.log(
    `cli-content: ✓ mf ${cliVersion}, ${maintainedPages.length} bilingual guides`
)
