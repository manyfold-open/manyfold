#!/usr/bin/env node

import path from 'node:path'
import { withScratchDatabase } from './scratch-db'
import {
    discoverPgTestFiles,
    parseTapSummary,
    runTestFiles
} from './pg-test-runner'

// #722: serial per-file execution hides cross-suite blast radius. A destructive
// harness that swept the whole database used to delete this sibling's live
// fixtures mid-flight (7 of 10 invocations red at a1fda5e4), and the retention
// file now owns a throwaway database of its own — so the pairing that used to
// fail is executed in ONE runner invocation, where node --test runs both files
// as concurrent child processes, rather than left to a one-off local proof.
export const CROSS_SUITE_PAIRINGS: string[][] = [
    ['test/chat-retention.pg.test.ts', 'test/chat-session-shares.pg.test.ts']
]

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
