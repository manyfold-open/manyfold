import path from 'node:path'
import {
    discoverPgTestFiles,
    parseTapSummary,
    runTestFiles
} from './pg-test-runner'

export function runPgTests(testDir = path.join(process.cwd(), 'test')): void {
    if (process.env.RUN_PG_E2E !== '1')
        throw new Error('RUN_PG_E2E=1 is required')
    const files = discoverPgTestFiles(testDir)
    if (!files.length) throw new Error('No PostgreSQL tests found')
    parseTapSummary(runTestFiles(files, process.env, 1), 'PostgreSQL suite')
}

if (process.argv[1] && path.basename(process.argv[1]) === 'run-pg-tests.ts') {
    try {
        runPgTests(process.argv[2])
    } catch (error) {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
    }
}
