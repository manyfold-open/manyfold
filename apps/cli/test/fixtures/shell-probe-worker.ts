import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const mode = process.env.MF_TEST_PROBE_MODE || process.argv.at(-1)
if (mode === 'success') process.stdout.write('/fixture/bin:/usr/bin')
else if (mode === 'failed') {
    process.stdout.write('/untrusted/partial')
    process.exitCode = 9
} else if (mode === 'flood') process.stdout.write('x'.repeat(128 * 1024))
else {
    process.on('SIGTERM', () => {})
    appendFileSync(process.env.MF_TEST_PROBE_PID_FILE!, `${process.pid}\n`)
    if (process.argv.at(-1) !== 'leaf')
        spawn(process.execPath, ['leaf'], {
            stdio: 'inherit',
            env: { ...process.env, MF_TEST_PROBE_MODE: '' }
        })
    setInterval(() => {}, 1000)
}
