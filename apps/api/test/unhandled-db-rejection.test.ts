import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// #843: a dropped database connection that some unawaited path never
// handled must not end the API process; any other unhandled rejection still
// does. Runs the real server-bootstrap handlers in a child process.
const runFixture = async (
    mode: 'db' | 'ordinary'
): Promise<{ code: number | null; output: string }> => {
    const child = spawn(
        process.execPath,
        [
            '--import',
            pathToFileURL(require.resolve('tsx')).href,
            join(__dirname, 'fixtures/unhandled-rejection.mjs'),
            mode
        ],
        {
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                TMPDIR: process.env.TMPDIR,
                NODE_ENV: 'test',
                TSX_TSCONFIG_PATH: join(__dirname, '../tsconfig.json'),
                DOTENV_CONFIG_PATH: '/dev/null'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    )
    let output = ''
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 60_000)
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject)
            child.on('exit', resolve)
        })
        return { code, output }
    } finally {
        clearTimeout(watchdog)
    }
}

test('an unhandled postgres.js connection failure is reported, not fatal', { timeout: 90_000 }, async () => {
    const { code, output } = await runFixture('db')
    assert.equal(code, 0, output)
    assert.match(output, /FIXTURE_SURVIVED/)
    assert.match(
        output,
        /process\.unhandled_rejection \{"outcome":"recovered","code":"CONNECTION_CLOSED"/
    )
    assert.doesNotMatch(output, /"reason":"unhandled_rejection"/)
})

test('any other unhandled rejection still ends the process', { timeout: 90_000 }, async () => {
    const { code, output } = await runFixture('ordinary')
    assert.equal(code, 1, output)
    assert.doesNotMatch(output, /FIXTURE_SURVIVED/)
    assert.match(output, /process\.exit \{"reason":"unhandled_rejection"/)
})
