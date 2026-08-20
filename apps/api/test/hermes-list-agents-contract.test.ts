import test from 'node:test'
import assert from 'node:assert/strict'
import { HermesAgentAdapter } from '../src/modules/agents/adapters/hermes-agent.adapter'

const HOME = '/home/user/.hermes'
const VENV_PYTHON = `${HOME}/hermes-agent/venv/bin/python3`

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'main',
    framework: 'hermes',
    kind: 'k8s',
    status: 'ready',
    accountId: null,
    spriteName: null,
    spriteId: null,
    primaryAgentId: 'agent-1',
    mountPath: HOME,
    homeDir: null,
    namespace: 'nca-dev',
    ingressHost: null,
    clusterId: null,
    spriteUrl: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

interface ExecResult {
    exitCode: number
    stdout: string
    stderr: string
}

const makeAdapter = (dispatch: (cmd: string[]) => ExecResult) => {
    const calls: string[][] = []
    const exec = {
        run: async ({ cmd }: { cmd: string[] }) => {
            calls.push(cmd)
            return dispatch(cmd)
        }
    }
    const adapter = new HermesAgentAdapter({
        forRuntime: async () => exec
    } as never)
    adapter['log'].warn = () => undefined
    return { adapter, calls }
}

const listCtx = () =>
    ({ runtime: fakeRuntime(), primaryAgentId: 'agent-1' }) as never

const isPythonDiscovery = (cmd: string[]) => cmd[1] === '-c'
const isFilesystemScan = (cmd: string[]) => cmd[0] === 'sh'

// Scenario 1: every python candidate exits 1 → listAgents rejects, no
// filesystem fallback — the fs fallback fabricates a partial list that always
// contains 'default', and trusting it orphan-marks every real profile not in it
test('hermes listAgents: rejects when every python candidate fails, without filesystem fallback', async () => {
    const { adapter, calls } = makeAdapter((cmd) => {
        if (isFilesystemScan(cmd))
            return { exitCode: 0, stdout: 'real-profile\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'boom' }
    })

    await assert.rejects(
        adapter.listAgents(listCtx()),
        /hermes profile discovery failed/,
        'broken python discovery must throw: the fs fallback fabricates a partial list that always contains default, and trusting it orphan-marks every real profile not in it'
    )
    assert.ok(
        !calls.some(isFilesystemScan),
        'listAgents must never consult the filesystem fallback — its fabricated list would orphan-mark real profiles'
    )
})

// Scenario 2: all candidates exit 0 with empty stdout → rejects — the
// discovery script unconditionally prints a JSON array, so silence is
// swallowed output, not emptiness
test('hermes listAgents: rejects when every candidate exits 0 with empty stdout', async () => {
    const { adapter } = makeAdapter(() => ({
        exitCode: 0,
        stdout: '',
        stderr: ''
    }))

    await assert.rejects(
        adapter.listAgents(listCtx()),
        /hermes profile discovery failed/,
        'the discovery script unconditionally prints a JSON array, so silence is swallowed output, not emptiness'
    )
})

// Scenario 3: one candidate exits 0 printing '[]' → resolves [] — a healthy
// interpreter explicitly reporting zero profiles is confirmed-empty
test('hermes listAgents: resolves [] when a healthy interpreter prints an empty array', async () => {
    const { adapter } = makeAdapter((cmd) => {
        if (isPythonDiscovery(cmd) && cmd[0] === VENV_PYTHON)
            return { exitCode: 0, stdout: '[]', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: '' }
    })

    const result = await adapter.listAgents(listCtx())
    assert.deepEqual(
        result,
        [],
        'a healthy interpreter explicitly reporting zero profiles is confirmed-empty'
    )
})

// Scenario 4: one candidate prints a valid JSON profile array → resolves
// mapped FrameworkAgent[] (success regression)
test('hermes listAgents: maps a valid python profile array to FrameworkAgent[]', async () => {
    const profile = {
        name: 'default',
        path: `${HOME}/profiles/default`,
        is_default: true,
        gateway_running: true,
        model: 'gpt-5',
        provider: 'openai',
        has_env: true,
        skill_count: 3,
        alias_path: null,
        active: true
    }
    const { adapter } = makeAdapter((cmd) => {
        if (isPythonDiscovery(cmd) && cmd[0] === VENV_PYTHON)
            return {
                exitCode: 0,
                stdout: JSON.stringify([profile]),
                stderr: ''
            }
        return { exitCode: 1, stdout: '', stderr: '' }
    })

    const result = await adapter.listAgents(listCtx())
    assert.deepEqual(
        result,
        [
            {
                id: 'default',
                name: 'default',
                workspace: `${HOME}/profiles/default`,
                model: 'gpt-5',
                extras: {
                    provider: 'openai',
                    gatewayRunning: true,
                    hasEnv: true,
                    skillCount: 3,
                    isDefault: true,
                    aliasPath: null,
                    active: true
                }
            }
        ],
        'a successful python listing must map id/name/workspace/model/extras unchanged'
    )
})

// Scenario 5: addAgent with create exit 0, python discovery broken, ls
// returning the new profile name → resolves with workspace
// `${home}/profiles/<id>` — strictness applies only to the reconcile-facing
// listing; enrichment after a confirmed create may stay lenient because a
// wrong workspace guess cannot orphan-mark anything
test('hermes addAgent: enrichment stays lenient when python discovery is broken after a confirmed create', async () => {
    const { adapter } = makeAdapter((cmd) => {
        if (cmd[0] === 'hermes' && cmd[1] === 'profile' && cmd[2] === 'create')
            return { exitCode: 0, stdout: '', stderr: '' }
        if (isFilesystemScan(cmd))
            return { exitCode: 0, stdout: 'p2\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'boom' }
    })

    const result = await adapter.addAgent({
        runtime: fakeRuntime(),
        primaryAgentId: 'agent-1',
        agentId: 'agent-2',
        internalId: 'p2',
        name: 'p2'
    } as never)

    assert.equal(result.internalId, 'p2')
    assert.equal(
        result.workspace,
        `${HOME}/profiles/p2`,
        'strictness applies only to the reconcile-facing listing — enrichment after a confirmed create may stay lenient because a wrong workspace guess cannot orphan-mark anything'
    )
})
