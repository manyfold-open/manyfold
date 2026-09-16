import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { claimDaemonPid, isProcessRunning } from '../src/daemon/pid'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const state = async (pid: number) => {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    return value.slice(value.lastIndexOf(') ') + 2)[0]
}

test(
    'an exited unreaped process does not retain daemon ownership on Linux',
    { skip: process.platform !== 'linux' },
    async () => {
        const dir = await mkdtemp('/tmp/mf-owner-exited-')
        const release = join(dir, 'release')
        const child = spawn(
            'bash',
            [
                '-c',
                '(while [ ! -f "$1" ]; do sleep 0.01; done) & child=$!; printf "%s\\n" "$child"; wait "$child"',
                '--',
                release
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        const done = new Promise<void>((resolve) =>
            child.once('close', () => resolve())
        )
        child.stderr.resume()
        let output = ''
        child.stdout.on('data', (data: Buffer) => {
            output += data.toString()
        })
        try {
            for (let i = 0; !output.includes('\n'); i++) {
                assert.ok(i < 100)
                await delay(10)
            }
            child.kill('SIGSTOP')
            for (let i = 0; (await state(child.pid!)) !== 'T'; i++) {
                assert.ok(i < 100)
                await delay(10)
            }
            const exitedPid = Number(output.trim())
            assert.ok(Number.isSafeInteger(exitedPid) && exitedPid > 1)
            await writeFile(release, '')
            for (let i = 0; (await state(exitedPid)) !== 'Z'; i++) {
                assert.ok(i < 100)
                await delay(10)
            }
            assert.equal(isProcessRunning(exitedPid), false)
            const pidPath = join(dir, 'daemon.pid')
            await mkdir(`${pidPath}.locks`, { recursive: true })
            await writeFile(
                join(`${pidPath}.locks`, 'owner.json'),
                JSON.stringify({ pid: exitedPid, instanceId: randomUUID() })
            )
            await writeFile(pidPath, String(exitedPid))
            const ownership = await claimDaemonPid(process.pid, { pidPath })
            try {
                assert.equal(
                    (await readFile(pidPath, 'utf8')).trim(),
                    String(process.pid)
                )
            } finally {
                await ownership.release()
            }
        } finally {
            await writeFile(release, '')
            child.kill('SIGCONT')
            await done
            await rm(dir, { recursive: true, force: true })
        }
    }
)
