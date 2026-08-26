#!/usr/bin/env node

// CONTRIBUTING asks for a changeset on every user-visible change, and until
// this existed the only thing holding that line was review. What gets through
// is not a red build but a release whose changelog does not say what changed,
// which is unrecoverable — the version ships, and nobody can reconstruct the
// note afterwards.
//
// `changeset status` cannot be the gate: it fails whenever a versionable
// package changed with no changeset at all, which is the normal state of an
// internal-only PR and of every release back-merge.
//
// So: on a pull request, every product package the PR touches must be named by
// a changeset THE PR ITSELF ADDS, or the PR must add an empty changeset saying
// why no release note is owed.
//
//   node scripts/check-changeset-presence.mjs   (or: pnpm changeset-presence:check)
//
// Scope is derived, not listed: a package is in scope exactly when
// `.changeset/config.json` does not ignore it, i.e. exactly when the versioner
// would bump it. Adding an app puts it in scope; moving a package to `ignore`
// takes it out. Nothing here needs editing for either.
//
// Deliberate limits, each chosen so a new blocking gate under-matches rather
// than cries wolf:
//
//   - Changesets already pending from earlier PRs do not count. Coverage must
//     come from this PR's own diff, or a PR would be excused by a stranger's
//     changeset that names the same package.
//   - `package.json` and `CHANGELOG.md` are out of scope. That is what makes
//     the Version Packages PR and the main -> develop sync PR pass without a
//     branch-name special case: they touch nothing else in a product package.
//     It also means a lockfile-only dependency bump is not asked for a note.
//   - Markdown and tests are out of scope.
//   - An internal package (`ignore`d) implies no surface, because which product
//     surface a shared change is visible through cannot be read off the path.
//     `.changeset/README.md` still asks the author to name the affected product
//     package; that half stays a review judgement.
//   - Only `pull_request` runs it (see ci.yml). A direct push to develop is not
//     gated.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { read as readConfig } from '@changesets/config'
import parseChangeset from '@changesets/parse'
import { getPackages } from '@manypkg/get-packages'

const CHANGESET_FILE = /^\.changeset\/[^/]+\.md$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const TEST_DIRS = new Set(['test', 'tests', '__tests__'])

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

const indent = (message) =>
    message
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')

// A changeset file the PR touched. README.md is documentation living in the
// same directory; config.json is not a `.md` and never matches.
export function isChangesetFile(relPath) {
    return CHANGESET_FILE.test(relPath) && !relPath.endsWith('/README.md')
}

// Whether a path inside a product package could carry a release-worthy change.
export function isReleaseNoteRelevant(relPath) {
    if (isChangesetFile(relPath)) return false

    const segments = relPath.split('/')
    const base = segments[segments.length - 1]

    if (base === 'package.json' || base === 'CHANGELOG.md') return false
    if (base.endsWith('.md')) return false
    if (TEST_FILE.test(base)) return false
    if (segments.slice(0, -1).some((segment) => TEST_DIRS.has(segment)))
        return false

    return true
}

// Longest dir first so a nested package wins over an ancestor.
export function surfacesFromPackages(packages, rootDir, ignored) {
    return packages
        .map((pkg) => ({
            name: pkg.packageJson.name,
            dir: path.relative(rootDir, pkg.dir).split(path.sep).join('/')
        }))
        .filter((surface) => surface.dir && !ignored.has(surface.name))
        .sort((left, right) => right.dir.length - left.dir.length)
}

export function touchedSurfaces(files, surfaces) {
    const touched = new Map()

    for (const file of files) {
        if (!isReleaseNoteRelevant(file)) continue
        const owner = surfaces.find(
            (surface) =>
                file === surface.dir || file.startsWith(`${surface.dir}/`)
        )
        if (!owner) continue
        if (!touched.has(owner.name)) touched.set(owner.name, file)
    }

    return touched
}

// Changesets this PR adds. A changeset the PR DELETES is a consumed one on a
// version PR, not coverage, so a file that no longer exists is skipped.
export function readAddedChangesets(rootDir, files, readFile = readChangeset) {
    const added = []

    for (const file of files.filter(isChangesetFile).sort(compare)) {
        const parsed = readFile(path.join(rootDir, file))
        if (parsed) added.push({ id: file, ...parsed })
    }

    return added
}

function readChangeset(absPath) {
    let contents
    try {
        contents = fs.readFileSync(absPath, 'utf8')
    } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
    }
    return parseChangeset(contents)
}

export function findPresenceFailures(touched, added) {
    const covered = new Set()
    const declined = []
    const unexplained = []

    for (const changeset of added) {
        if (changeset.releases.length > 0) {
            for (const release of changeset.releases) covered.add(release.name)
            continue
        }
        // `pnpm changeset --empty` writes the frontmatter and leaves the body
        // blank. A declination with no reason is as opaque as a missing note.
        if (changeset.summary.trim()) declined.push(changeset.id)
        else unexplained.push(changeset.id)
    }

    const missing = [...touched.keys()]
        .filter((name) => !covered.has(name))
        .sort(compare)

    return { missing, declined, unexplained }
}

export function formatFailures(touched, { missing, declined, unexplained }) {
    const failures = []

    for (const id of unexplained) {
        failures.push(
            `${id}\n${indent(
                'empty changeset with no reason. Write one sentence in its body\n' +
                    'saying why this change owes no release note, or delete it and\n' +
                    'run `pnpm changeset`.'
            )}`
        )
    }

    if (missing.length > 0 && declined.length === 0) {
        for (const name of missing) {
            failures.push(
                `${name}\n${indent(
                    `changed by this PR (e.g. ${touched.get(name)}) but no changeset it adds names it.`
                )}`
            )
        }
    }

    return failures
}

export function changedFiles(base, cwd, run = spawnSync) {
    const result = run('git', ['diff', '--name-only', base, 'HEAD'], {
        cwd,
        encoding: 'utf8'
    })

    if (result.error) throw result.error
    if (result.status !== 0)
        throw new Error(
            `git diff --name-only ${base} HEAD failed:\n${(result.stderr || '').trim()}`
        )

    return result.stdout.split('\n').filter(Boolean)
}

export async function checkChangesetPresence(cwd, base) {
    const packages = await getPackages(cwd)
    const rootDir = packages.root.dir
    const config = await readConfig(rootDir, packages)
    const surfaces = surfacesFromPackages(
        packages.packages,
        rootDir,
        new Set(config.ignore)
    )
    const files = changedFiles(base, rootDir)
    const touched = touchedSurfaces(files, surfaces)
    const added = readAddedChangesets(rootDir, files)
    const verdict = findPresenceFailures(touched, added)

    return {
        touched,
        added,
        ...verdict,
        failures: formatFailures(touched, verdict)
    }
}

async function main() {
    const base = process.env.TURBO_SCM_BASE

    if (!base) {
        console.error('changeset presence check failed:')
        console.error(
            indent(
                'TURBO_SCM_BASE is not set. In CI it is exported by\n' +
                    'scripts/ci-scm-base.sh; locally run\n' +
                    '`TURBO_SCM_BASE=$(git merge-base HEAD origin/develop) pnpm changeset-presence:check`.'
            )
        )
        process.exitCode = 1
        return
    }

    let result
    try {
        result = await checkChangesetPresence(process.cwd(), base)
    } catch (error) {
        console.error('changeset presence check failed:')
        console.error(
            indent(error instanceof Error ? error.message : String(error))
        )
        process.exitCode = 1
        return
    }

    const { touched, declined, failures } = result

    if (failures.length > 0) {
        console.error('changeset presence check failed:')
        for (const failure of failures) console.error(`- ${failure}`)
        console.error(
            '\nAdd one:          pnpm changeset   (pick every affected product surface)\n' +
                'Or declare none:  pnpm changeset --empty   (write the reason in its body)\n' +
                '.changeset/README.md covers which packages to name and which bump to pick.'
        )
        process.exitCode = 1
        return
    }

    if (touched.size === 0) {
        console.log(
            'changeset presence check passed: no product surface changed'
        )
        return
    }

    const names = [...touched.keys()].sort(compare).join(', ')

    if (declined.length > 0) {
        console.log(
            `changeset presence check passed: ${names} changed; ${declined.join(', ')} declares no release note is owed`
        )
        return
    }

    console.log(`changeset presence check passed: ${names} covered`)
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    await main()
}
