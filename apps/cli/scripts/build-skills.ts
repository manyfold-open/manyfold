#!/usr/bin/env -S node --import tsx
import { join } from 'node:path'
import {
    buildSkillBundle,
    cliDir,
    DEFAULT_SKILL_VERSION,
    pluginSkillDir,
    SKILL_NAME,
    writeSkillBundle
} from './skill-bundle'

const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--plugin'))
    throw new Error('Only --plugin is supported')
const version = process.env.MF_SKILLS_VERSION ?? DEFAULT_SKILL_VERSION
const bundle = buildSkillBundle(version)
const dir = join(cliDir, 'dist-skills/skills', SKILL_NAME)
writeSkillBundle(dir, bundle)
if (args.includes('--plugin')) writeSkillBundle(pluginSkillDir, bundle)
console.log(
    `build-skills: ${SKILL_NAME} v${version}, ${Object.keys(bundle).length} files`
)
console.log(`build-skills: wrote ${dir}`)
if (args.includes('--plugin'))
    console.log(`build-skills: wrote ${pluginSkillDir}`)
