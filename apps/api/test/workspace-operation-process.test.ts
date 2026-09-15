import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
    cancelWorkspaceOperationScript,
    shellQuote,
    trackedWorkspaceScript
} from '../src/modules/backups/workspace-operation-scripts'

const exec = promisify(execFile)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const processState = async (pid: number | string): Promise<string> => {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0]
}

test(
    'an exited operation is idle even when its Linux parent has not reaped it',
    { skip: process.platform !== 'linux' },
    async () => {
        const dir = await mkdtemp(join(tmpdir(), 'mf-backup-zombie-'))
        const root = join(dir, 'operation')
        const ready = join(dir, 'ready')
        const release = join(dir, 'release')
        const child = spawn(
            'bash',
            [
                '-c',
                trackedWorkspaceScript(
                    root,
                    'archive',
                    `touch ${shellQuote(ready)}; while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done; exit 3`
                )
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        child.stdout.resume()
        child.stderr.resume()
        const done = new Promise((resolve) => child.once('close', resolve))
        try {
            for (let n = 0; ; n++) {
                try {
                    await readFile(ready)
                    break
                } catch {}
                assert.ok(n < 100)
                await delay(20)
            }
            child.kill('SIGSTOP')
            for (let n = 0; (await processState(child.pid!)) !== 'T'; n++) {
                assert.ok(
                    n < 100,
                    'the parent must stop before releasing its child'
                )
                await delay(20)
            }
            await writeFile(release, '')
            const pid = (
                await readFile(join(root, 'archive', 'pid'), 'utf8')
            ).trim()
            for (let n = 0; (await processState(pid)) !== 'Z'; n++) {
                assert.ok(
                    n < 100,
                    'the child must exit before checking the group'
                )
                await delay(20)
            }
            const response = await exec('bash', [
                '-c',
                cancelWorkspaceOperationScript(root)
            ])
            assert.match(response.stdout, /active=0/)
        } finally {
            await writeFile(release, '')
            child.kill('SIGCONT')
            await done
            await rm(dir, { recursive: true })
        }
    }
)

test(
    'the watchdog still bounds live descendants after their leader is killed',
    { skip: process.platform !== 'linux' },
    async () => {
        const dir = await mkdtemp(join(tmpdir(), 'mf-backup-descendant-'))
        const root = join(dir, 'operation')
        const ready = join(dir, 'ready')
        const child = spawn(
            'bash',
            [
                '-c',
                trackedWorkspaceScript(
                    root,
                    'restore',
                    `trap '' TERM; touch ${shellQuote(ready)}; while true; do sleep 0.1; done`,
                    1
                )
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        child.stdout.resume()
        child.stderr.resume()
        const exited = new Promise((resolve) => child.once('exit', resolve))
        const done = new Promise((resolve) => child.once('close', resolve))
        let group: number | undefined
        try {
            for (let n = 0; ; n++) {
                try {
                    await readFile(ready)
                    break
                } catch {}
                assert.ok(n < 100)
                await delay(20)
            }
            group = Number(
                (await readFile(join(root, 'restore', 'pid'), 'utf8')).trim()
            )
            process.kill(group, 'SIGKILL')
            await exited
            assert.match(
                (
                    await exec('bash', [
                        '-c',
                        cancelWorkspaceOperationScript(root)
                    ])
                ).stdout,
                /active=1/
            )
            let timeout: ReturnType<typeof setTimeout> | undefined
            try {
                await Promise.race([
                    done,
                    new Promise((_, reject) => {
                        timeout = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        'the surviving process outlived its watchdog'
                                    )
                                ),
                            10000
                        )
                    })
                ])
            } finally {
                if (timeout) clearTimeout(timeout)
            }
            assert.match(
                (
                    await exec('bash', [
                        '-c',
                        cancelWorkspaceOperationScript(root)
                    ])
                ).stdout,
                /active=0/
            )
        } finally {
            if (group) {
                try {
                    process.kill(-group, 'SIGKILL')
                } catch {}
            }
            await done
            await rm(dir, { recursive: true })
        }
    }
)
