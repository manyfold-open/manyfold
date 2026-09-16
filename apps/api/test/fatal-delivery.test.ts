import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test(
    'fresh-boot fatal delivery shares one deadline and signal flush retains its budget',
    { timeout: 150_000 },
    async (t) => {
        const directory = await mkdtemp(
            join(tmpdir(), 'manyfold-fatal-delivery-')
        )
        t.after(() => rm(directory, { recursive: true, force: true }))
        const child = spawn(
            process.execPath,
            [
                join(__dirname, 'telemetry-pipeline.e2e.mjs'),
                directory,
                'deadline'
            ],
            {
                env: { ...process.env, RUN_TELEMETRY_E2E: '1' },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        )
        t.after(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
        })
        let output = ''
        child.stdout.on('data', (data) => {
            output += data
        })
        child.stderr.on('data', (data) => {
            output += data
        })
        const code = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject)
            child.on('exit', resolve)
        })
        assert.equal(code, 0, output)
        const report = JSON.parse(
            await readFile(join(directory, 'result.json'), 'utf8')
        )
        assert.equal(report.pass, true)
        assert.equal(report.cases.length, 2)
        for (const result of report.cases) t.diagnostic(result)
    }
)
