import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Worker {
    child: ChildProcess
    messages: Array<{
        kind: string
        pid?: number
        ownerPid?: number | null
        message?: string
    }>
    exited: Promise<void>
    done: boolean
    stderr: string
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = async (worker: Worker, kinds: string[]) => {
    const deadline = Date.now() + 10000
    for (;;) {
        const found = worker.messages.find(
            (item) => kinds.includes(item.kind) || item.kind === 'error'
        )
        if (found) {
            assert.notEqual(found.kind, 'error', found.message)
            return found
        }
        assert.ok(!worker.done, `worker exited early: ${worker.stderr}`)
        assert.ok(Date.now() < deadline, `worker timed out: ${worker.stderr}`)
        await delay(10)
    }
}

const createWorker = (
    pidPath: string,
    workers: Worker[],
    binary = false
): Worker => {
    const child = spawn(
        binary ? process.env.MF_TEST_LOCK_WORKER! : process.execPath,
        binary
            ? [pidPath]
            : [
                  '--import',
                  'tsx',
                  fileURLToPath(
                      new URL(
                          './fixtures/daemon-owner-worker.ts',
                          import.meta.url
                      )
                  ),
                  pidPath
              ],
        {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            serialization: 'json',
            env: {
                ...process.env,
                MF_CONFIG_DIR: join(pidPath, '..', 'profile')
            }
        }
    )
    const worker: Worker = {
        child,
        messages: [],
        exited: Promise.resolve(),
        done: false,
        stderr: ''
    }
    worker.exited = new Promise((resolve) =>
        child.once('exit', () => {
            worker.done = true
            resolve()
        })
    )
    child.on('message', (value) =>
        worker.messages.push(value as Worker['messages'][number])
    )
    child.stderr?.on('data', (data: Buffer) => {
        worker.stderr += data.toString()
    })
    workers.push(worker)
    return worker
}

const withWorkers = async (
    run: (dir: string, workers: Worker[]) => Promise<void>
) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-owner-process-'))
    const workers: Worker[] = []
    try {
        await run(dir, workers)
    } finally {
        for (const worker of workers)
            if (!worker.done) worker.child.kill('SIGKILL')
        await Promise.all(workers.map((worker) => worker.exited))
        await rm(dir, { recursive: true, force: true })
    }
}

const contend = async (pidPath: string, workers: Worker[]) => {
    const contenders = Array.from({ length: 8 }, () =>
        createWorker(pidPath, workers)
    )
    await Promise.all(contenders.map((worker) => message(worker, ['ready'])))
    for (const worker of contenders) worker.child.send('claim')
    const outcomes = await Promise.all(
        contenders.map((worker) => message(worker, ['acquired', 'busy']))
    )
    assert.equal(
        outcomes.filter((outcome) => outcome.kind === 'acquired').length,
        1
    )
    const winner =
        contenders[outcomes.findIndex((outcome) => outcome.kind === 'acquired')]
    assert.equal(
        (await readFile(pidPath, 'utf8')).trim(),
        String(winner.child.pid)
    )
    assert.equal(
        JSON.parse(
            await readFile(join(`${pidPath}.locks`, 'owner.json'), 'utf8')
        ).pid,
        winner.child.pid
    )
    return winner
}

test('concurrent processes admit one owner, including after a killed owner', async () => {
    await withWorkers(async (dir, workers) => {
        const pidPath = join(dir, 'daemon.pid')
        const first = await contend(pidPath, workers)
        first.child.kill('SIGKILL')
        await first.exited
        const second = await contend(pidPath, workers)
        second.child.send('release')
        await message(second, ['released'])
        await second.exited
        assert.deepEqual(
            await readdir(`${pidPath}.locks`),
            process.platform === 'win32' ? [] : ['lock']
        )
        await assert.rejects(readFile(pidPath), { code: 'ENOENT' })
    })
})

test('independent profiles can own separate daemons concurrently', async () => {
    await withWorkers(async (dir, workers) => {
        const first = createWorker(join(dir, 'a.pid'), workers)
        const second = createWorker(join(dir, 'b.pid'), workers)
        await Promise.all([
            message(first, ['ready']),
            message(second, ['ready'])
        ])
        first.child.send('claim')
        second.child.send('claim')
        await Promise.all([
            message(first, ['acquired']),
            message(second, ['acquired'])
        ])
        first.child.send('release')
        second.child.send('release')
        await Promise.all([
            message(first, ['released']),
            message(second, ['released'])
        ])
    })
})

test(
    'a paused owner with old metadata cannot be taken over',
    { skip: process.platform === 'win32' },
    async () => {
        await withWorkers(async (dir, workers) => {
            const pidPath = join(dir, 'daemon.pid')
            const first = createWorker(pidPath, workers)
            await message(first, ['ready'])
            first.child.send('claim')
            await message(first, ['acquired'])
            first.child.kill('SIGSTOP')
            await utimes(
                join(`${pidPath}.locks`, 'owner.json'),
                new Date(0),
                new Date(0)
            )
            const second = createWorker(pidPath, workers)
            await message(second, ['ready'])
            second.child.send('claim')
            const blocked = await message(second, ['busy'])
            assert.equal(blocked.ownerPid, first.child.pid)
            assert.equal(
                (await readFile(pidPath, 'utf8')).trim(),
                String(first.child.pid)
            )
            first.child.kill('SIGCONT')
            first.child.send('release')
            await message(first, ['released'])
        })
    }
)

test(
    'Node and a standalone Bun worker use the same kernel lock',
    { skip: !process.env.MF_TEST_LOCK_WORKER },
    async () => {
        for (const binaryFirst of [false, true]) {
            await withWorkers(async (dir, workers) => {
                const pidPath = join(dir, 'daemon.pid')
                const first = createWorker(pidPath, workers, binaryFirst)
                await message(first, ['ready'])
                first.child.send('claim')
                await message(first, ['acquired'])
                const second = createWorker(pidPath, workers, !binaryFirst)
                await message(second, ['ready'])
                second.child.send('claim')
                await message(second, ['busy'])
                first.child.kill('SIGKILL')
                await first.exited
                const next = createWorker(pidPath, workers, !binaryFirst)
                await message(next, ['ready'])
                next.child.send('claim')
                await message(next, ['acquired'])
                next.child.send('release')
                await message(next, ['released'])
            })
        }
    }
)
