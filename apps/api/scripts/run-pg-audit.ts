#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { withScratchDatabase } from './scratch-db'

type TapSummary = {
    tests: number
    pass: number
    fail: number
    cancelled: number
    skipped: number
    todo: number
}

// #722: serial per-file execution hides cross-suite blast radius. A destructive
// harness that swept the whole database used to delete this sibling's live
// fixtures mid-flight (7 of 10 invocations red at a1fda5e4), and the retention
// file now owns a throwaway database of its own — so the pairing that used to
// fail is executed in ONE runner invocation, where node --test runs both files
// as concurrent child processes, rather than left to a one-off local proof.
export const CROSS_SUITE_PAIRINGS: string[][] = [
    ['test/chat-retention.pg.test.ts', 'test/chat-session-shares.pg.test.ts']
]

export function parseTapSummary(output: string, file: string): TapSummary {
    const field = (name: keyof TapSummary): number => {
        const matches = [
            ...output.matchAll(new RegExp(`^# ${name} ([0-9]+)$`, 'gm'))
        ]
        if (matches.length !== 1)
            throw new Error(`${file}: expected one TAP ${name} summary`)
        return Number(matches[0]?.[1])
    }

    const summary: TapSummary = {
        tests: field('tests'),
        pass: field('pass'),
        fail: field('fail'),
        cancelled: field('cancelled'),
        skipped: field('skipped'),
        todo: field('todo')
    }
    if (summary.tests === 0) throw new Error(`${file}: no tests executed`)
    if (
        summary.fail !== 0 ||
        summary.cancelled !== 0 ||
        summary.skipped !== 0 ||
        summary.todo !== 0 ||
        summary.pass !== summary.tests
    )
        throw new Error(
            `${file}: incomplete TAP result ${JSON.stringify(summary)}`
        )
    return summary
}

export function discoverPgTestFiles(testDir: string): string[] {
    return fs
        .readdirSync(testDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.pg.test.ts'))
        .map((entry) => path.join(testDir, entry.name))
        .sort()
}

const runChild = (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv
): string => {
    const result = spawnSync(command, args, {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status !== 0)
        throw new Error(
            `${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`
        )
    return result.stdout
}

export const testRunnerArgs = (files: string[]): string[] => [
    '--import',
    'tsx',
    '--test',
    `--test-concurrency=${files.length}`,
    '--test-force-exit',
    '--test-reporter=tap',
    ...files
]

const runTestFiles = (files: string[], env: NodeJS.ProcessEnv): string =>
    runChild(process.execPath, testRunnerArgs(files), env)

const run = async (): Promise<void> => {
    await withScratchDatabase(
        'audit',
        async ({ url }) => {
            const childEnv = {
                ...process.env,
                DATABASE_URL: url,
                RUN_PG_E2E: '1'
            }

            const files = discoverPgTestFiles(path.join(process.cwd(), 'test'))
            if (files.length === 0) throw new Error('No PostgreSQL tests found')

            let tests = 0
            for (const file of files) {
                const relative = path.relative(process.cwd(), file)
                console.log(`\n=== ${relative} ===`)
                tests += parseTapSummary(
                    runTestFiles([relative], childEnv),
                    relative
                ).tests
            }

            for (const pairing of CROSS_SUITE_PAIRINGS) {
                const label = `concurrent ${pairing.join(' + ')}`
                console.log(`\n=== ${label} ===`)
                for (const member of pairing)
                    if (!files.includes(path.join(process.cwd(), member)))
                        throw new Error(
                            `${label}: ${member} is not a discovered PostgreSQL test`
                        )
                tests += parseTapSummary(
                    runTestFiles(pairing, childEnv),
                    label
                ).tests
            }

            console.log(
                `PostgreSQL audit passed: ${files.length} files, ${CROSS_SUITE_PAIRINGS.length} concurrent pairings, ${tests} tests, 0 skipped`
            )
        },
        { log: console.log }
    )
}

const isCli =
    process.argv[1] && path.basename(process.argv[1]) === 'run-pg-audit.ts'

if (isCli)
    run().catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
    })
