#!/usr/bin/env -S node --import tsx
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAgentHelp } from '../src/agent-help/helpers'

// Generates the first-party "manyfold-cli-usage" skill from the SAME agent-help
// source that `mf help --agent` serves, so the published skill can never drift
// from the CLI guide. The release workflow runs this, then publishes dist-skills/
// to the public skills repo the platform registers as a builtin source.
//
// Layout (the repo mirrors this): dist-skills/skills/manyfold-cli-usage/SKILL.md

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const helpDir = join(pkgDir, 'src', 'agent-help')
const outDir = join(pkgDir, 'dist-skills')

const version = process.env.MF_SKILLS_VERSION ?? '0.0.0-dev'

const SKILL_NAME = 'manyfold-cli-usage'
const SKILL_DESCRIPTION =
    'Operate the Manyfold platform and delegate to peer agents on the ' +
    "user's behalf via the mf CLI (channels, automations, skills, files, " +
    'backups, model config, usage, auth/scopes, and A2A). Run `mf help --agent` ' +
    'for the always-current guide.'

const render = (src: string): string =>
    renderAgentHelp(readFileSync(join(helpDir, src), 'utf8')).trim()

const frontmatter = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    `version: ${version}`,
    '---',
    ''
].join('\n')

// One coherent document, not two concatenated guides: the operations entry
// guide (index.md, keeps its H1 as the skill title) with the A2A guide folded
// in as a section — its standalone H1 dropped and its `##` headings demoted to
// `###` so the hierarchy stays clean. Both halves are still rendered exactly as
// `mf help index|a2a --agent` would, so the skill can't drift from the CLI.
const operations = render('index.md')
const a2a = render('a2a.md')
    .replace(/^#[^\n]*\n+/, '')
    .replace(/^##\s/gm, '### ')
    .trim()
const body = `${operations}\n\n## Calling peer agents (A2A)\n\n${a2a}\n`

const skillDir = join(outDir, 'skills', SKILL_NAME)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), `${frontmatter}${body}`, 'utf8')

console.log(`build-skills: ✓ skills/${SKILL_NAME}/SKILL.md (v${version})`)
console.log(`build-skills: bundle written to ${outDir}`)
