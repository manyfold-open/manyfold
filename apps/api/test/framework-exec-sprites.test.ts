import test from 'node:test'
import assert from 'node:assert/strict'
import type { ExecOptions, ExecResult, SpritesClient } from '@manyfold/sprites'
import {
    FrameworkExecResolver,
    SpritesFrameworkExec
} from '../src/modules/agents/adapters/framework-exec'

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'main',
    framework: 'openclaw',
    kind: 'sprites',
    status: 'ready',
    accountId: 'acc-1',
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    daemonId: null,
    primaryAgentId: 'agent-1',
    mountPath: '/home/sprite/.openclaw/workspace',
    homeDir: '/home/sprite/.openclaw',
    namespace: null,
    ingressHost: null,
    clusterId: null,
    ...over
})

const account = { id: 'acc-1', slug: 'acct' }

const accountsStub = (found = true) => ({
    getById: async () => (found ? account : null),
    decryptToken: () => 'tok-decrypted'
})

class SeamResolver extends FrameworkExecResolver {
    readonly execs: Array<{ spriteName: string; opts: ExecOptions }> = []
    result: ExecResult = { exitCode: 0, stdout: '', stderr: '' }

    protected override async execSprite(
        _client: SpritesClient,
        spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        this.execs.push({ spriteName, opts })
        return this.result
    }
}

const seamResolver = (accounts = accountsStub()) =>
    new SeamResolver(
        {} as never,
        {} as never,
        {} as never,
        accounts as never
    )

// WHY bash -lc: framework CLIs on sprites live on login-shell-only PATH
// entries (openclaw in ~/.local/bin, hermes in its venv) — a raw argv exec
// would not find them. The quoting must survive spaces, quotes and newlines
// because the hermes adapter ships a multi-line python -c script.
test('SpritesFrameworkExec wraps argv in bash -lc with safe single-quoting', async () => {
    const calls: ExecOptions[] = []
    const exec = new SpritesFrameworkExec(
        {} as SpritesClient,
        'sprite-1',
        async (_c, _s, opts) => {
            calls.push(opts)
            return { exitCode: 0, stdout: '', stderr: '' }
        }
    )
    await exec.run({
        cmd: ['python3', '-c', `print("a b")\nx='q'`],
        timeoutMs: 30_000
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cmd[0], 'bash')
    assert.equal(calls[0].cmd[1], '-lc')
    assert.equal(
        calls[0].cmd[2],
        `'python3' '-c' 'print("a b")\nx='\\''q'\\'''`
    )
    assert.equal(calls[0].timeoutMs, 30_000)
    assert.equal('env' in calls[0], false)
    assert.equal('dir' in calls[0], false)
    assert.equal('stdin' in calls[0], false)
})

test('SpritesFrameworkExec passes env, dir and stdin through and maps the result', async () => {
    const calls: ExecOptions[] = []
    const exec = new SpritesFrameworkExec(
        {} as SpritesClient,
        'sprite-1',
        async (_c, _s, opts) => {
            calls.push(opts)
            return {
                exitCode: 3,
                stdout: 'out',
                stderr: 'err',
                sessionId: 'sess-1'
            }
        }
    )
    const res = await exec.run({
        cmd: ['openclaw', 'agents', 'list', '--json'],
        env: { FOO: 'bar' },
        dir: '/home/sprite',
        stdin: 'payload',
        timeoutMs: 5_000
    })
    assert.deepEqual(calls[0].env, { FOO: 'bar' })
    assert.equal(calls[0].dir, '/home/sprite')
    assert.equal(calls[0].stdin, 'payload')
    assert.deepEqual(res, { exitCode: 3, stdout: 'out', stderr: 'err' })
})

test('forRuntime resolves a sprites runtime to an exec bound to its spriteName', async () => {
    const resolver = seamResolver()
    resolver.result = { exitCode: 0, stdout: 'ok', stderr: '' }
    const exec = await resolver.forRuntime(
        fakeRuntime() as never,
        'agent-1'
    )
    const res = await exec.run({ cmd: ['true'], timeoutMs: 1_000 })
    assert.equal(res.exitCode, 0)
    assert.equal(resolver.execs.length, 1)
    assert.equal(resolver.execs[0].spriteName, 'nca-user-abc-main')
    assert.deepEqual(resolver.execs[0].opts.cmd, ['bash', '-lc', `'true'`])
})

test('forRuntime throws for a sprites runtime missing spriteName', async () => {
    const resolver = seamResolver()
    await assert.rejects(
        resolver.forRuntime(
            fakeRuntime({ spriteName: null }) as never,
            'agent-1'
        ),
        /kind=sprites but no spriteName/
    )
})

test('forRuntime throws for a sprites runtime missing accountId', async () => {
    const resolver = seamResolver()
    await assert.rejects(
        resolver.forRuntime(
            fakeRuntime({ accountId: null }) as never,
            'agent-1'
        ),
        /kind=sprites but no accountId/
    )
})

test('forRuntime throws when the sprites account row is gone', async () => {
    const resolver = seamResolver(accountsStub(false))
    await assert.rejects(
        resolver.forRuntime(fakeRuntime() as never, 'agent-1'),
        /sprites account acc-1 not found/
    )
})

// WHY: the adapter truth contract — an unresolvable execution channel must
// throw so reconcile records a failure instead of treating it as empty.
test('forRuntime still rejects unsupported runtime kinds', async () => {
    const resolver = seamResolver()
    await assert.rejects(
        resolver.forRuntime(
            fakeRuntime({ kind: 'external' }) as never,
            'agent-1'
        ),
        /framework exec only supports k8s, daemon or sprites/
    )
})
