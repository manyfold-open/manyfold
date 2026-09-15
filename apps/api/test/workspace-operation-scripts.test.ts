import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspaceRuntimeService } from '../src/modules/backups/workspace-runtime.service'
import {
    cancelWorkspaceOperationScript,
    shellQuote,
    trackedWorkspaceScript
} from '../src/modules/backups/workspace-operation-scripts'

const exec = promisify(execFile)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('interrupted restore returns the original directory unless the switch committed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-restore-recover-'))
    const workspace = join(dir, 'workspace')
    const runtime = Object.create(
        WorkspaceRuntimeService.prototype
    ) as WorkspaceRuntimeService
    Object.assign(runtime, {
        run: (_agent: unknown, script: string) => exec('bash', ['-c', script]),
        log: { warn() {} }
    })
    const { mkdir } = await import('node:fs/promises')
    try {
        for (const committed of [false, true]) {
            const id = committed ? 'committed' : 'interrupted'
            const old = join(dir, `.nca-restore-old-${id}`)
            await mkdir(old)
            await writeFile(join(old, 'value'), 'original')
            await mkdir(workspace, { recursive: true })
            await writeFile(join(workspace, 'value'), 'replacement')
            if (committed)
                await writeFile(join(dir, `.nca-restore-committed-${id}`), '')
            await runtime.recoverOperation(
                { mountPath: workspace } as never,
                id,
                true
            )
            assert.equal(
                await readFile(join(workspace, 'value'), 'utf8'),
                committed ? 'replacement' : 'original'
            )
            await assert.rejects(readFile(join(old, 'value')))
        }
    } finally {
        await rm(dir, { recursive: true })
    }
})

test('workspace phase cancellation fences delayed commands and duplicate replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-backup-script-'))
    try {
        const root = join(dir, 'operation')
        assert.match(
            (await exec('bash', ['-c', cancelWorkspaceOperationScript(root)]))
                .stdout,
            /active=0/
        )
        await assert.rejects(
            exec('bash', [
                '-c',
                trackedWorkspaceScript(
                    root,
                    'restore',
                    `touch ${shellQuote(join(dir, 'mutation'))}`
                )
            ])
        )
        await assert.rejects(readFile(join(dir, 'mutation')))
        const next = join(dir, 'next')
        const script = trackedWorkspaceScript(
            next,
            'archive',
            'printf "done\\n"'
        )
        assert.match((await exec('bash', ['-c', script])).stdout, /done/)
        await assert.rejects(exec('bash', ['-c', script]))
        assert.match(
            (await exec('bash', ['-c', cancelWorkspaceOperationScript(next)]))
                .stdout,
            /active=0/
        )
    } finally {
        await rm(dir, { recursive: true })
    }
})

test('workspace phase remains busy until a real archive process group exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-backup-script-'))
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
                [
                    `touch ${shellQuote(ready)}`,
                    `while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done`
                ].join('\n')
            )
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child.stdout.resume()
    child.stderr.resume()
    const done = new Promise<number | null>((resolve) =>
        child.once('close', resolve)
    )
    try {
        for (let n = 0; ; n++) {
            try {
                await readFile(ready)
                break
            } catch {}
            assert.ok(n < 100, 'archive phase did not start')
            await delay(20)
        }
        assert.match(
            (await exec('bash', ['-c', cancelWorkspaceOperationScript(root)]))
                .stdout,
            /active=1/
        )
        await writeFile(release, '')
        assert.equal(await done, 0)
        assert.match(
            (await exec('bash', ['-c', cancelWorkspaceOperationScript(root)]))
                .stdout,
            /active=0/
        )
    } finally {
        await writeFile(release, '')
        await done
        await rm(dir, { recursive: true })
    }
})

test('losing the command wrapper does not make its surviving file operation look idle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-backup-orphan-'))
    const root = join(dir, 'operation')
    const ready = join(dir, 'ready')
    const release = join(dir, 'release')
    const child = spawn(
        'bash',
        [
            '-c',
            trackedWorkspaceScript(
                root,
                'restore',
                [
                    `touch ${shellQuote(ready)}`,
                    `while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done`
                ].join('\n')
            )
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child.stdout.resume()
    child.stderr.resume()
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const closed = new Promise((resolve) => child.once('close', resolve))
    try {
        for (let n = 0; ; n++) {
            try {
                await readFile(ready)
                break
            } catch {}
            assert.ok(n < 100)
            await delay(20)
        }
        child.kill('SIGTERM')
        await exited
        assert.match(
            (await exec('bash', ['-c', cancelWorkspaceOperationScript(root)]))
                .stdout,
            /active=1/
        )
        await writeFile(release, '')
        await closed
        assert.match(
            (await exec('bash', ['-c', cancelWorkspaceOperationScript(root)]))
                .stdout,
            /active=0/
        )
    } finally {
        await writeFile(release, '')
        await closed
        await rm(dir, { recursive: true })
    }
})
