import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import type { SdkAgent } from '@manyfold/sdk'
import {
    applyAgentStatusSnapshots,
    applyHostPowerUpdate
} from '../src/lib/chatAgents'
import {
    canSyncRuntimeSession,
    runtimeSyncOpenKey
} from '../src/lib/runtimeSessionSync'

// The chat page pulls a terminal TUI's transcript in once per opened session.
// What it keys that sync on decides how often it runs: the sandbox's power
// updates rebuild the agent object, and a sync on a sleeping sandbox wakes it.

const agent = (over: Partial<SdkAgent> = {}): SdkAgent =>
    ({
        id: 'agt_1',
        framework: 'claude-code',
        runtime: 'sprites',
        hostId: 'sbx_1',
        powerState: 'suspended',
        daemonOnline: false,
        availability: 'wakeable',
        ...over
    }) as SdkAgent

// How many times the open sync fires as `keys` arrive in order: on every
// change to a key that is set.
const syncsFor = (keys: Array<string | null>): number => {
    let last: string | null = null
    let fired = 0
    for (const key of keys) {
        if (key !== last && key !== null) fired++
        last = key
    }
    return fired
}

test('power updates rebuild the agent but not the key, so a held-open page syncs once', () => {
    let agents = [agent()]
    const keys: Array<string | null> = []
    for (let cycle = 0; cycle < 40; cycle++) {
        const powerState = cycle % 2 === 0 ? 'running' : 'suspended'
        const before = agents[0]
        agents = applyHostPowerUpdate(agents, {
            hostId: 'sbx_1',
            powerState,
            daemonOnline: powerState === 'running'
        })
        agents = applyAgentStatusSnapshots(agents, [
            {
                agentId: 'agt_1',
                powerState,
                availability: powerState === 'running' ? 'available' : 'wakeable'
            } as never
        ])
        assert.notEqual(agents[0], before, 'each power update is a new object')
        keys.push(runtimeSyncOpenKey(agents[0], 'cs_1', 'cs_1'))
    }
    assert.equal(syncsFor(keys), 1)
})

test('the key waits for the session first page, and changes per session', () => {
    const a = agent()
    assert.equal(runtimeSyncOpenKey(a, 'cs_1', null), null)
    assert.equal(runtimeSyncOpenKey(a, 'cs_1', 'cs_0'), null, 'still the old page')
    assert.equal(runtimeSyncOpenKey(a, 'cs_1', 'cs_1'), 'agt_1:cs_1')
    assert.equal(runtimeSyncOpenKey(a, 'cs_2', 'cs_2'), 'agt_1:cs_2')
    assert.equal(runtimeSyncOpenKey(a, null, null), null)
})

test('an agent that arrives after its first page still syncs once', () => {
    assert.equal(
        syncsFor([
            runtimeSyncOpenKey(undefined, 'cs_1', 'cs_1'),
            runtimeSyncOpenKey(agent(), 'cs_1', 'cs_1'),
            runtimeSyncOpenKey(agent({ powerState: 'running' }), 'cs_1', 'cs_1')
        ]),
        1
    )
})

test('only coding CLIs on a Manyfold machine sync', () => {
    for (const framework of ['claude-code', 'codex', 'pi', 'antigravity-cli'])
        assert.equal(canSyncRuntimeSession(agent({ framework } as never)), true, framework)
    for (const framework of ['hermes', 'openclaw'])
        assert.equal(canSyncRuntimeSession(agent({ framework } as never)), false, framework)
    assert.equal(canSyncRuntimeSession(agent({ runtime: 'external' } as never)), false)
    assert.equal(canSyncRuntimeSession(null), false)
    assert.equal(runtimeSyncOpenKey(agent({ framework: 'hermes' } as never), 'cs_1', 'cs_1'), null)
})

// The page wires the key in: checked on the source, as the page needs its
// providers to mount.
const chat = ts.createSourceFile(
    'AgentChat.tsx',
    readFileSync(new URL('../src/pages/AgentChat.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
)

const hookCalls = (name: string): ts.CallExpression[] => {
    const found: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === name
        )
            found.push(node)
        ts.forEachChild(node, visit)
    }
    visit(chat)
    return found
}

const depsOf = (call: ts.CallExpression): string[] => {
    const deps = call.arguments[1]
    assert.ok(deps && ts.isArrayLiteralExpression(deps), 'a dependency list')
    return deps.elements.map((element) => element.getText(chat))
}

test('the chat page runs the open sync on the session key, not on the agent object', () => {
    const sync = hookCalls('useCallback').find((call) => {
        const parent = call.parent
        return (
            ts.isVariableDeclaration(parent) &&
            parent.name.getText(chat) === 'syncRuntimeSessionAndReload'
        )
    })
    assert.ok(sync, 'syncRuntimeSessionAndReload is a useCallback')
    assert.deepEqual(depsOf(sync), ['client', 'reloadSessionMessages'])
    const open = hookCalls('useEffect').find((call) =>
        call.arguments[0]?.getText(chat).includes('syncRuntimeSessionAndReload(false)')
    )
    assert.ok(open, 'the session-open effect')
    assert.deepEqual(depsOf(open), ['openSyncKey', 'syncRuntimeSessionAndReload'])
})
