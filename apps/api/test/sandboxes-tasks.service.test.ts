import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException
} from '@nestjs/common'
import type {
    ExecOptions,
    ExecResult,
    SpritesClient
} from '@manyfold/sprites'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

const ok = (stdout: string): ExecResult => ({
    exitCode: 0,
    stdout,
    stderr: ''
})

class TestSandboxes extends SandboxesService {
    execCalls: ExecOptions[] = []
    execResult: ExecResult = ok('{"tasks":[]}')
    execError: Error | null = null

    protected exec(
        _client: SpritesClient,
        _spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        this.execCalls.push(opts)
        return this.execError
            ? Promise.reject(this.execError)
            : Promise.resolve(this.execResult)
    }
}

const baseHost = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_1',
    userId: 'u1',
    spriteId: 'spr_1',
    spriteName: 'sbx-sprite',
    accountId: 'spa_1',
    spriteStatus: 'running',
    ...over
})

const makeService = (host: Record<string, unknown> = baseHost()) => {
    const runtimes = {
        getSandboxForUser: async () => ({ host }),
        getSandboxById: async () => ({ host })
    }
    const accounts = {
        getById: async () => ({ id: 'spa_1', slug: 'acct' }),
        decryptToken: () => 'tok'
    }
    return new TestSandboxes(
        runtimes as never,
        {} as never,
        accounts as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
}

test('deleteTask refuses platform keep-alive leases before touching the sprite', async () => {
    const svc = makeService()

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'nca-claude-code-ab12-1'),
        BadRequestException
    )
    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'hermes-keepalive'),
        BadRequestException
    )
    assert.equal(svc.execCalls.length, 0)
})

test('deleteTask refuses when the sandbox is not running (never wakes it)', async () => {
    const svc = makeService(baseHost({ spriteStatus: 'warm' }))

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        ConflictException
    )
    assert.equal(svc.execCalls.length, 0)
})

test('deleteTask encodes the hostile task name and verifies via re-list', async () => {
    const svc = makeService()
    const name = 'web srv/№1'
    svc.execResult = ok('{"tasks":[{"name":"other"}]}')

    await svc.deleteTask('u1', 'sbx_1', name)

    assert.equal(svc.execCalls.length, 1)
    const opts = svc.execCalls[0]
    assert.equal(opts.env?.NCA_TASK_NAME, encodeURIComponent(name))
    assert.equal(opts.cmd[0], 'bash')
    assert.match(
        opts.cmd[2],
        /-X DELETE "\/v1\/tasks\/\$NCA_TASK_NAME"/,
        'delete must target the env-transported name'
    )
    assert.match(
        opts.cmd[2],
        /; sprite-env curl -s \/v1\/tasks$/,
        'must end with the verify list'
    )
    assert.ok(!opts.cmd[2].includes(name), 'raw name must not reach the shell')
    assert.equal(opts.timeoutMs, 20_000)
    assert.equal(opts.keepAliveMs, 5_000)
    assert.equal(opts.livenessTimeoutMs, 12_000)
})

test('deleteTask treats an already-absent task as success', async () => {
    const svc = makeService()
    svc.execResult = ok('{"tasks":[]}')

    await svc.deleteTask('u1', 'sbx_1', 'my-task')
})

test('deleteTask fails loud when the task survives the delete', async () => {
    const svc = makeService()
    svc.execResult = ok('{"tasks":[{"name":"my-task"}]}')

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        (err: Error) =>
            err instanceof ConflictException &&
            /still registered/.test(err.message)
    )
})

test('deleteTask surfaces exec transport failures', async () => {
    const svc = makeService()
    svc.execError = new Error('socket hangup')

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        ServiceUnavailableException
    )
})

test('deleteTask refuses to report success when the verify list is unreadable', async () => {
    const svc = makeService()
    svc.execResult = { exitCode: 1, stdout: '', stderr: 'boom' }
    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        ServiceUnavailableException
    )

    svc.execResult = ok('not json')
    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        ServiceUnavailableException
    )
})

test('listTasks flags platform leases as keepAlive', async () => {
    const svc = makeService()
    svc.execResult = ok(
        JSON.stringify({
            tasks: [
                { name: 'nca-codex-ab12cd-3', expires_at: '2026-07-06T00:00:00Z' },
                { name: 'hermes-keepalive' },
                { name: 'my-http-server' }
            ]
        })
    )

    const tasks = await svc.listTasks('u1', 'sbx_1')

    assert.deepEqual(
        tasks.map((t) => [t.name, t.keepAlive]),
        [
            ['nca-codex-ab12cd-3', true],
            ['hermes-keepalive', true],
            ['my-http-server', false]
        ]
    )
})
