import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenclawAgentAdapter } from '../src/modules/agents/adapters/openclaw-agent.adapter'

const MOUNT = '/home/user/.openclaw'

// openclaw 2026.7.x `agents add` prompts interactively for a workspace when
// the flag is absent (exit 13 on the non-TTY runtime exec) and rejects a
// directory that does not exist. These tests pin the adapter's answer: the
// add always carries --workspace, and a managed default is created only
// when the caller chose nothing.
const makeAdapter = (
    opts: { mkdirExitCode?: number } = {}
): { adapter: OpenclawAgentAdapter; calls: string[][] } => {
    const calls: string[][] = []
    const exec = {
        run: async (req: { cmd: string[] }) => {
            calls.push(req.cmd)
            if (req.cmd[0] === 'mkdir')
                return {
                    exitCode: opts.mkdirExitCode ?? 0,
                    stdout: '',
                    stderr: opts.mkdirExitCode ? 'permission denied' : ''
                }
            if (req.cmd[0] === 'openclaw')
                return {
                    exitCode: 0,
                    stdout: JSON.stringify({
                        id: req.cmd[3],
                        workspace: req.cmd[req.cmd.indexOf('--workspace') + 1]
                    }),
                    stderr: ''
                }
            // bash -lc workspace preflight for caller-chosen paths
            return { exitCode: 0, stdout: 'ok\n', stderr: '' }
        }
    }
    const adapter = new OpenclawAgentAdapter({
        forRuntime: async () => exec
    } as never)
    return { adapter, calls }
}

const ctx = (workspace?: string): never =>
    ({
        runtime: { id: 'rt-1', mountPath: MOUNT },
        primaryAgentId: 'agent-0',
        agentId: 'agent_1abc',
        internalId: 'agent-1abc',
        name: 'Added',
        workspace
    }) as never

test('openclaw addAgent without a workspace creates and passes a managed default', async () => {
    const { adapter, calls } = makeAdapter()
    const res = await adapter.addAgent(ctx())
    const derived = `${MOUNT}/workspace-agent-1abc`
    assert.deepEqual(
        calls[0],
        ['mkdir', '-p', derived],
        'the CLI rejects a workspace that does not exist, so the managed default must be created before the add runs'
    )
    assert.deepEqual(
        calls[1],
        [
            'openclaw',
            'agents',
            'add',
            'agent-1abc',
            '--workspace',
            derived,
            '--json'
        ],
        'agents add without --workspace prompts interactively and exits 13 on the non-TTY runtime exec, so the flag must always be carried'
    )
    assert.equal(res.workspace, derived)
})

test('openclaw addAgent with a caller-chosen workspace asserts it, never creates it', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.addAgent(ctx('/srv/projects/app'))
    assert.ok(
        !calls.some((cmd) => cmd[0] === 'mkdir'),
        'a caller-chosen path is a claim about an existing directory; silently manufacturing it would hide a typo instead of failing the request'
    )
    assert.equal(
        calls[0][0],
        'bash',
        'caller-chosen workspaces keep going through the usability preflight'
    )
    const add = calls.find((cmd) => cmd[0] === 'openclaw')
    assert.ok(add)
    assert.equal(add[add.indexOf('--workspace') + 1], '/srv/projects/app')
})

test('openclaw addAgent surfaces a failed default-workspace mkdir instead of prompting later', async () => {
    const { adapter, calls } = makeAdapter({ mkdirExitCode: 1 })
    await assert.rejects(
        adapter.addAgent(ctx()),
        /creating default workspace .* failed \(exit 1\)/,
        'if the default cannot be created the add would die on the interactive prompt anyway — fail with the real cause, not exit 13'
    )
    assert.ok(
        !calls.some((cmd) => cmd[0] === 'openclaw'),
        'the add must not run against a workspace that could not be created'
    )
})
