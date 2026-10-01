#!/usr/bin/env node
// A PR that changes what the plugin ships must raise its version, the same in
// both manifests. Claude Code and Codex keep one installed copy per version
// string: until the version moves, `claude plugin update` answers "already at
// the latest version" and users keep the old skill.
//
//   TURBO_SCM_BASE=$(git merge-base HEAD origin/develop) pnpm plugin-version:check

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { changedFiles } from './check-changeset-presence.mjs'

export const PLUGIN_DIR = 'plugins/manyfold'
export const MANIFESTS = [
    `${PLUGIN_DIR}/.claude-plugin/plugin.json`,
    `${PLUGIN_DIR}/.codex-plugin/plugin.json`
]
// About the plugin, not part of what a host loads.
const DOCS = new Set([
    `${PLUGIN_DIR}/README.md`,
    `${PLUGIN_DIR}/DEVELOPMENT.md`
])

export const isShipped = (file) =>
    file.startsWith(`${PLUGIN_DIR}/`) && !DOCS.has(file)

const SEMVER =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseVersion(version) {
    const match = SEMVER.exec(typeof version === 'string' ? version : '')
    if (!match) return null
    return { core: match.slice(1, 4).map(Number), pre: match[4] ?? null }
}

const comparePrerelease = (a, b) => {
    const x = a.split('.')
    const y = b.split('.')
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] === undefined) return -1
        if (y[i] === undefined) return 1
        const numeric = [/^\d+$/.test(x[i]), /^\d+$/.test(y[i])]
        if (numeric[0] && numeric[1]) {
            if (Number(x[i]) !== Number(y[i]))
                return Number(x[i]) < Number(y[i]) ? -1 : 1
        } else if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1
        else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    }
    return 0
}

// Semver precedence: build metadata does not count, so a release can't be
// told apart from the last one by its `+…` suffix alone.
export function compareVersions(a, b) {
    const x = parseVersion(a)
    const y = parseVersion(b)
    for (let i = 0; i < 3; i++)
        if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
    if (x.pre === y.pre) return 0
    if (x.pre === null) return 1
    if (y.pre === null) return -1
    return comparePrerelease(x.pre, y.pre)
}

export function findPluginVersionFailures({
    changed,
    baseVersion,
    headVersions
}) {
    const failures = []
    for (const [file, version] of Object.entries(headVersions))
        if (!parseVersion(version))
            failures.push(
                `${file}: ${JSON.stringify(version)} is not a semver version`
            )
    if (new Set(Object.values(headVersions)).size > 1)
        failures.push(
            `the manifests disagree (${Object.entries(headVersions)
                .map(([file, version]) => `${file}: ${version}`)
                .join(', ')}); give both the same version`
        )
    if (failures.length > 0) return failures

    const shipped = changed.filter(isShipped)
    // A plugin the base did not have has no installed copies to update.
    if (shipped.length === 0 || baseVersion === null) return failures
    const version = Object.values(headVersions)[0]
    const raised = parseVersion(baseVersion)
        ? compareVersions(version, baseVersion) > 0
        : version !== baseVersion
    if (!raised)
        failures.push(
            `this PR changes what the plugin ships (${shipped[0]}${shipped.length > 1 ? ` and ${shipped.length - 1} more` : ''}) ` +
                `but its version is ${version}, not above ${baseVersion}: raise it in both manifests`
        )
    return failures
}

const readBaseVersion = (base, cwd) => {
    try {
        const text = execFileSync('git', ['show', `${base}:${MANIFESTS[0]}`], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        })
        return JSON.parse(text).version ?? null
    } catch {
        return null
    }
}

export function checkPluginVersion(cwd, base) {
    const changed = changedFiles(base, cwd).flatMap((file) =>
        file.oldPath ? [file.oldPath, file.path] : [file.path]
    )
    const headVersions = Object.fromEntries(
        MANIFESTS.map((file) => [
            file,
            JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8')).version
        ])
    )
    return findPluginVersionFailures({
        changed,
        baseVersion: readBaseVersion(base, cwd),
        headVersions
    })
}

async function main() {
    const base = process.env.TURBO_SCM_BASE
    if (!base) {
        console.error(
            'plugin version check failed: TURBO_SCM_BASE is not set. In CI it is\n' +
                'exported by scripts/ci-scm-base.sh; locally run\n' +
                '`TURBO_SCM_BASE=$(git merge-base HEAD origin/develop) pnpm plugin-version:check`.'
        )
        process.exitCode = 1
        return
    }
    const failures = checkPluginVersion(process.cwd(), base)
    if (failures.length > 0) {
        console.error('plugin version check failed:')
        for (const failure of failures) console.error(`  ${failure}`)
        process.exitCode = 1
        return
    }
    console.log('plugin version check passed')
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    await main()
}
