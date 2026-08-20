#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Publishes the first-party skills bundle (skills/manyfold-cli-usage) to the
// public skills repo the platform registers as a builtin source. Builds the
// workspace deps, regenerates from agent-help at the given version, then clones
// → replaces skills/ → commits → pushes main + tag. Auth uses the operator's
// `gh` credentials.
//
//   node scripts/publish-skills.mjs 0.2.0   (or: just skills-release 0.2.0)

const version = process.argv[2] ?? process.env.MF_SKILLS_VERSION
if (!version) {
    console.error('usage: publish-skills.mjs <version>')
    process.exit(1)
}

const REPO = 'protagolabs/manyfold-skills'
const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const repoRoot = resolve(pkgDir, '../..')

const README = readFileSync(join(here, 'skills-readme.md'), 'utf8')

const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { stdio: 'inherit', ...opts })

// 1. Build the workspace deps. build-skills imports agent-help/helpers, which
// imports @manyfold/shared — resolved to its dist/, so a checkout that has only
// ever run `pnpm install` cannot generate the bundle without this.
run('pnpm', ['--filter', '@manyfold/cli^...', 'build'], { cwd: repoRoot })

// 2. Regenerate the bundle at this version.
run('node', ['--import', 'tsx', 'scripts/build-skills.ts'], {
    cwd: pkgDir,
    env: { ...process.env, MF_SKILLS_VERSION: version }
})

// 3. Clone the skills repo (history-preserving publish).
const tmp = mkdtempSync(join(tmpdir(), 'mf-skills-'))
const repoDir = join(tmp, 'repo')
try {
    run('gh', ['repo', 'clone', REPO, repoDir, '--', '-q'])

    // 4. Replace skills/ with the freshly generated bundle + refresh README.
    rmSync(join(repoDir, 'skills'), { recursive: true, force: true })
    cpSync(join(pkgDir, 'dist-skills', 'skills'), join(repoDir, 'skills'), {
        recursive: true
    })
    writeFileSync(join(repoDir, 'README.md'), README)

    // 5. Commit + push + tag (no-op if nothing changed).
    run('git', ['add', '-A'], { cwd: repoDir })
    const dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: repoDir
    })
        .toString()
        .trim()
    if (!dirty) {
        console.log(`skills: no changes — ${REPO} already at v${version}`)
        process.exit(0)
    }
    const ident = [
        '-c',
        'user.name=Manyfold Bot',
        '-c',
        'user.email=noreply@manyfold.ai'
    ]
    const ghCred = ['-c', 'credential.helper=!gh auth git-credential']
    run('git', [...ident, 'commit', '--no-gpg-sign', '-m', `manyfold skills v${version}`], {
        cwd: repoDir
    })
    run('git', [...ghCred, 'push', 'origin', 'HEAD:main'], { cwd: repoDir })
    run('git', ['tag', '-f', `skills-v${version}`], { cwd: repoDir })
    run('git', [...ghCred, 'push', '--force', 'origin', `skills-v${version}`], {
        cwd: repoDir
    })
    console.log(`skills: published v${version} to ${REPO}`)
} finally {
    rmSync(tmp, { recursive: true, force: true })
}
