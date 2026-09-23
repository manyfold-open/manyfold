import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MANYFOLD_CLI_USAGE_SKILL_ID } from '@manyfold/shared'
import {
    buildSkillBundle,
    compareSkillBundles,
    fetchPublishedSkill,
    pluginSkillDir,
    readSkillBundle,
    skillBundleVersion,
    SKILL_NAME
} from './skill-bundle'

const published = process.argv.includes('--published')
if (process.argv.slice(2).some((arg) => arg !== '--published'))
    throw new Error('Only --published is supported')

const local = readSkillBundle(pluginSkillDir)
const actual = published
    ? await fetchPublishedSkill(MANYFOLD_CLI_USAGE_SKILL_ID)
    : {
          files: local,
          version: local['SKILL.md'] ? skillBundleVersion(local) : undefined
      }
const differences = compareSkillBundles(
    buildSkillBundle(actual.version),
    actual.files
)
if (!published) {
    const installedNames = readdirSync(dirname(pluginSkillDir)).filter((name) =>
        existsSync(join(dirname(pluginSkillDir), name, 'SKILL.md'))
    )
    if (installedNames.length !== 1 || installedNames[0] !== SKILL_NAME)
        differences.push(
            'plugin must contain only the unified manyfold-cli-usage skill'
        )
}
if (differences.length) {
    console.error(differences.join('\n'))
    throw new Error(
        published
            ? 'Published skill differs from source; release the complete skill bundle after merge.'
            : 'Plugin skill differs from source; run pnpm --filter @manyfold/cli build:plugin.'
    )
}
console.log(
    `skills: ${published ? 'published' : 'plugin'} bundle matches source (${Object.keys(actual.files).length} files)`
)
