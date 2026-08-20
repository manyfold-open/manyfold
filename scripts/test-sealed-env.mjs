#!/usr/bin/env node

// Runs a test command in a sealed environment.
//
// Three hazards this closes, all of which the suites are otherwise exposed to
// because they inherit the developer's or the runner's whole environment:
//
//   * a real agent CLI on PATH. The api and cli suites exercise agent
//     subprocess orchestration, so a stub that stops working (or a new code
//     path that spawns by bare name) reaches the real `claude`/`codex`/… and
//     burns real tokens against whatever credentials are lying around. Every
//     framework CLI this repository can spawn gets a sentinel earlier on PATH
//     that records the call and exits 126, so the run fails loudly instead.
//   * ambient credentials. Anything secret-shaped is dropped, along with the
//     brokers that hand out a credential without ever looking like one.
//   * `apps/api/.env`. Many PostgreSQL tests `import 'dotenv/config'` at module
//     top, which on a developer checkout reads that file and puts back exactly
//     what was just stripped. DOTENV_CONFIG_PATH is pointed at an empty file so
//     the import loads nothing.
//
// A test that plants its own stub still wins: it prepends its own directory,
// which lands ahead of the sentinel directory.
//
// WHAT THIS IS NOT. It is not a sandbox, and it does not try to be one in
// process-level terms:
//
//   * HOME is untouched by design, because the suites need it, so ~/.ssh,
//     ~/.aws, ~/.kube, ~/.docker and ~/.npmrc all remain readable on disk. What
//     the seal removes is the ambient POINTER to them.
//   * the PATH sentinels cover agent CLIs only. Anything else on PATH resolves
//     for real, which the suites depend on.
//
// The guarantee is therefore: a test cannot ACCIDENTALLY reach a credential
// through the environment it inherited. A test that deliberately goes looking
// in HOME still finds one.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// apps/cli/src/daemon/detect.ts BINARY_FOR_FRAMEWORK is the source of truth
// for which of ADR-0006's frameworks have a CLI that gets spawned by name.
// Deliberately absent: node, bash, sh, npm, npx, curl, tar, docker (the
// suites resolve those for real), and `mf` (only ever run by absolute path).
export const AGENT_CLIS = ['claude', 'codex', 'gemini', 'openclaw', 'hermes']

export const LOG_VAR = 'MF_TEST_AGENT_CLI_LOG'

// Kept even though none of them currently match the shape rule: this is the
// contract for what a sealed test run is allowed to see, so widening the rule
// later cannot quietly take them away.
const KEEP = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TZ',
    'CI',
    'DATABASE_URL',
    'RUN_PG_E2E',
    'PG_TEST_SCRATCH',
    'PG_TEST_ADMIN_URL',
    'TEST_SHARD',
    'NODE_OPTIONS'
])

// AWS_SECRET_ACCESS_KEY and STRIPE_SECRET_KEY end in _KEY rather than
// _API_KEY, so the trailing segment is matched on its own.
const SECRET_SHAPED =
    /(?:^|_)(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|BEARER)$/i

// Brokers: none of these IS a credential, so none matches the shape rule, but
// each names or opens one. A tool that reads them needs no secret in the
// environment at all.
const CREDENTIAL_BROKERS = new Set([
    'AWS_CONFIG_FILE',
    'AWS_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'DOCKER_AUTH_CONFIG',
    'DOCKER_CONFIG',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'KUBECONFIG',
    'NETRC',
    'NPM_CONFIG_USERCONFIG',
    'SSH_AUTH_SOCK'
])

export const DOTENV_PATH_VAR = 'DOTENV_CONFIG_PATH'

export function sealedEnv(source, { sentinelDir, logFile, dotenvPath } = {}) {
    const env = {}
    const stripped = []
    for (const [name, value] of Object.entries(source)) {
        if (KEEP.has(name)) {
            env[name] = value
            continue
        }
        if (SECRET_SHAPED.test(name) || CREDENTIAL_BROKERS.has(name)) {
            stripped.push(name)
            continue
        }
        env[name] = value
    }

    env.TZ = 'UTC'
    if (dotenvPath) env[DOTENV_PATH_VAR] = dotenvPath
    if (sentinelDir)
        env.PATH = [sentinelDir, source.PATH ?? '']
            .filter(Boolean)
            .join(path.delimiter)
    if (logFile) env[LOG_VAR] = logFile

    return { env, stripped: stripped.sort() }
}

export function writeSentinels(dir, names = AGENT_CLIS) {
    fs.mkdirSync(dir, { recursive: true })
    for (const name of names) {
        const file = path.join(dir, name)
        fs.writeFileSync(
            file,
            [
                '#!/bin/sh',
                `printf '%s %s\\n' "${name}" "$*" >> "$${LOG_VAR}"`,
                `echo "manyfold sealed test env: a test reached the real ${name} CLI" >&2`,
                'exit 126',
                ''
            ].join('\n')
        )
        fs.chmodSync(file, 0o755)
    }
    return dir
}

const isCli =
    process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isCli) {
    const argv = process.argv.slice(2)
    const separator = argv.indexOf('--')
    const command = separator === -1 ? argv : argv.slice(separator + 1)
    if (command.length === 0) {
        console.error('usage: test-sealed-env.mjs -- <command> [args...]')
        process.exit(2)
    }

    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-sealed-env-'))
    const sentinelDir = writeSentinels(path.join(box, 'bin'))
    const logFile = path.join(box, 'agent-cli-invocations.log')
    fs.writeFileSync(logFile, '')
    // An empty file rather than a missing one: dotenv resolves the path itself
    // and would fall back to ./.env if this pointed at nothing.
    const dotenvPath = path.join(box, 'empty.env')
    fs.writeFileSync(dotenvPath, '')

    const { env, stripped } = sealedEnv(process.env, {
        sentinelDir,
        logFile,
        dotenvPath
    })
    if (stripped.length > 0)
        console.log(`sealed test env: dropped ${stripped.join(', ')}`)

    const child = spawn(command[0], command.slice(1), {
        stdio: 'inherit',
        env
    })

    const finish = (code) => {
        const invocations = fs.readFileSync(logFile, 'utf8').trim()
        fs.rmSync(box, { recursive: true, force: true })
        if (invocations) {
            console.error(
                'sealed test env: the run reached a real agent CLI, which would have spent real credentials:'
            )
            for (const line of invocations.split('\n'))
                console.error(`- ${line}`)
            process.exit(1)
        }
        process.exit(code)
    }

    child.on('error', (error) => {
        console.error(
            `sealed test env: cannot run ${command[0]}: ${error.message}`
        )
        finish(127)
    })
    child.on('exit', (code, signal) => finish(signal ? 128 : (code ?? 1)))
}
