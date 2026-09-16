import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

type TapSummary = {
    tests: number
    pass: number
    fail: number
    cancelled: number
    skipped: number
    todo: number
}

export function discoverPgTestFiles(testDir: string): string[] {
    return fs
        .readdirSync(testDir, { withFileTypes: true })
        .flatMap((entry) => {
            const file = path.join(testDir, entry.name)
            if (entry.isDirectory()) return discoverPgTestFiles(file)
            return entry.isFile() && entry.name.endsWith('.pg.test.ts')
                ? [file]
                : []
        })
        .sort()
}

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

export const testRunnerArgs = (
    files: string[],
    concurrency = files.length
): string[] => [
    '--import',
    'tsx',
    '--test',
    `--test-concurrency=${concurrency}`,
    '--test-reporter=tap',
    ...files
]

export function runTestFiles(
    files: string[],
    env: NodeJS.ProcessEnv,
    concurrency = files.length
): string {
    const childEnv = { ...env }
    delete childEnv.NODE_TEST_CONTEXT
    const result = spawnSync(
        process.execPath,
        testRunnerArgs(files, concurrency),
        {
            cwd: process.cwd(),
            env: childEnv,
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024
        }
    )
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status !== 0)
        throw new Error(
            `PostgreSQL tests exited with ${result.status ?? 'no status'}`
        )
    return result.stdout
}
