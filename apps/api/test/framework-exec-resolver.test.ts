import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceUnavailableException } from '@nestjs/common'
import { FrameworkExecResolver } from '../src/modules/agents/adapters/framework-exec'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'

// A framework command runs on the runtime's host through its daemon, and each
// one under the machine's awake hold (ADR-0038): a command must not outlive the
// hold it needs, or a sprite suspends ~1s after the last platform-visible
// activity and freezes the command under it.

const host = (kind: 'hosted' | 'local') => ({
    id: kind === 'hosted' ? 'sbx_1' : 'dh_1',
    kind,
    name: kind === 'hosted' ? 'sandbox-001' : 'laptop'
})

const build = (opts: { kind: 'hosted' | 'local'; offline?: boolean }) => {
    const sessions: Array<{ hostId: string; reason: string }> = []
    const resolver = new FrameworkExecResolver(
        {
            forRuntime: async () => ({
                host: host(opts.kind),
                placement: opts.kind === 'hosted' ? 'sprites' : 'daemon'
            })
        } as never,
        {
            withHost: async (
                args: { host: { id: string }; reason: string },
                work: (session: unknown) => Promise<unknown>
            ) => {
                sessions.push({ hostId: args.host.id, reason: args.reason })
                if (opts.offline)
                    throw new HostDaemonOfflineError(
                        args.host as never,
                        'runner_unavailable'
                    )
                return work({
                    exec: async (req: { cmd: string[] }) => ({
                        exitCode: 0,
                        stdout: req.cmd.join(' '),
                        stderr: ''
                    })
                })
            }
        } as never
    )
    const runtime = { id: 'art_1', hostId: host(opts.kind).id } as never
    return { resolver, runtime, sessions }
}

test('each framework command is its own held session on the runtime host', async () => {
    const { resolver, runtime, sessions } = build({ kind: 'hosted' })
    const exec = await resolver.forRuntime(runtime)

    const first = await exec.run({ cmd: ['codex', '--version'], timeoutMs: 1_000 })
    await exec.run({ cmd: ['true'], timeoutMs: 1_000 })

    assert.equal(first.stdout, 'codex --version')
    assert.deepEqual(sessions, [
        { hostId: 'sbx_1', reason: 'framework-exec' },
        { hostId: 'sbx_1', reason: 'framework-exec' }
    ])
})

// WHY: callers and the web read these codes to tell "start your computer"
// from "the sandbox did not come up".
test('an unreachable host answers the coded 503 it always has', async () => {
    for (const [kind, code] of [
        ['hosted', 'SANDBOX_DAEMON_OFFLINE'],
        ['local', 'DAEMON_OFFLINE']
    ] as const) {
        const { resolver, runtime } = build({ kind, offline: true })
        const exec = await resolver.forRuntime(runtime)
        await assert.rejects(
            exec.run({ cmd: ['true'], timeoutMs: 1_000 }),
            (err) => {
                assert.ok(err instanceof ServiceUnavailableException)
                const body = err.getResponse() as { code?: string; hostId?: string }
                assert.equal(body.code, code)
                assert.equal(body.hostId, host(kind).id)
                return true
            }
        )
    }
})
