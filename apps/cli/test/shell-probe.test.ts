import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { runShellProbe } from '../src/daemon/shell-probe'
import { augmentPathFromUserShell } from '../src/daemon/shell-path'
import { resolveBinariesViaLoginShell } from '../src/daemon/login-shell-path'

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}
const wait = async (predicate: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 6000
    while (!(await predicate())) {
        assert.ok(Date.now() < deadline, 'probe fixture did not settle')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

test(
    'shell probes bound failures and reap their own descendants without changing the caller group',
    {
        skip: process.platform === 'win32' && !process.env.MF_TEST_SHELL_WORKER,
        timeout: 30000
    },
    async (t) => {
        const directory = await mkdtemp(join(tmpdir(), 'mf-shell-probe-'))
        const pidFile = join(directory, 'pids')
        const previous = {
            path: process.env.PATH,
            shell: process.env.SHELL,
            pids: process.env.MF_TEST_PROBE_PID_FILE,
            mode: process.env.MF_TEST_PROBE_MODE
        }
        t.after(async () => {
            for (const [key, value] of Object.entries({
                PATH: previous.path,
                SHELL: previous.shell,
                MF_TEST_PROBE_PID_FILE: previous.pids,
                MF_TEST_PROBE_MODE: previous.mode
            })) {
                if (value === undefined) delete process.env[key]
                else process.env[key] = value
            }
            await rm(directory, { recursive: true, force: true })
        })
        process.env.MF_TEST_PROBE_PID_FILE = pidFile
        let worker = process.env.MF_TEST_SHELL_WORKER
        if (!worker) {
            worker = join(directory, 'zsh')
            await writeFile(
                worker,
                `#!/bin/sh
case "\${MF_TEST_PROBE_MODE:-$2}" in
success) printf /fixture/bin:/usr/bin; exit 0;;
failed) printf /untrusted/partial; exit 9;;
flood) /usr/bin/head -c 131072 /dev/zero; exit 0;;
esac
trap '' TERM
echo $$ >> "$MF_TEST_PROBE_PID_FILE"
/bin/sh -c 'trap "" TERM; echo $$ >> "$MF_TEST_PROBE_PID_FILE"; while :; do /bin/sleep 1; done' &
wait
`,
                { mode: 0o755 }
            )
        }
        const shell = worker
        assert.deepEqual(await runShellProbe(shell, 'success'), {
            status: 'ok',
            output: '/fixture/bin:/usr/bin'
        })
        assert.deepEqual(await runShellProbe(shell, 'failed'), {
            status: 'failed',
            output: ''
        })
        assert.equal(
            (await runShellProbe(join(directory, 'missing'), '')).status,
            'failed'
        )
        assert.equal(
            (await runShellProbe(shell, 'flood')).status,
            'output_limit'
        )
        const getPids = async () =>
            (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number)
        const gone = async () => {
            const pids = await getPids()
            assert.equal(pids.length, 2)
            assert.ok(pids.every((pid) => pid !== process.pid))
            await wait(() => pids.every((pid) => !alive(pid)))
        }
        const started = Date.now()
        assert.equal((await runShellProbe(shell, 'hang')).status, 'timeout')
        assert.ok(Date.now() - started >= 2800 && Date.now() - started < 5000)
        await gone()
        await writeFile(pidFile, '')
        const controller = new AbortController()
        const aborted = runShellProbe(shell, 'hang', controller.signal)
        await wait(async () => {
            try {
                return (await getPids()).length === 2
            } catch {
                return false
            }
        })
        controller.abort()
        assert.equal((await aborted).status, 'aborted')
        await gone()
        process.env.SHELL = shell
        process.env.MF_TEST_PROBE_MODE = 'failed'
        process.env.PATH = '/original/bin:/usr/bin'
        const messages: string[] = []
        await augmentPathFromUserShell(async (message) => {
            messages.push(message)
        }, new AbortController().signal)
        assert.equal(
            process.env.PATH,
            [
                ...new Set([
                    dirname(process.execPath),
                    '/original/bin',
                    '/usr/bin'
                ])
            ].join(':')
        )
        assert.ok(
            messages.some((message) =>
                message.includes('retaining current PATH')
            )
        )
        if (process.platform !== 'win32' && !process.env.MF_TEST_SHELL_WORKER) {
            process.env.MF_TEST_PROBE_MODE = 'hang'
            await writeFile(pidFile, '')
            assert.deepEqual(
                await resolveBinariesViaLoginShell(['mf-fixture']),
                {}
            )
            await gone()
        }
    }
)
