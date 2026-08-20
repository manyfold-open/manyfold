import {
    AgentFramework,
    AgentRuntime,
    externalSteps,
    frameworkCapabilities,
    frameworkCapability,
    isExternal,
    k8sCliSteps,
    k8sSteps,
    spritesServiceSteps,
    spritesSteps,
    stepsFor,
    supportsRuntime
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'

// ADR-0006 behaviour-preserving snapshot. The framework-capability module must
// reproduce the answer every migrated call site computed before the refactor.
// The ONE intentional change: stepsFor(external) now returns externalSteps — the
// former api-only stepsFor lacked an external branch and fell through to k8sSteps,
// salvaged only by the fail-loud fallback in agents.controller.ts.

interface Expected {
    kind: 'coding' | 'service' | 'external'
    runtimes: AgentRuntime[]
    configSubdir: string | null
}

const GROUND_TRUTH: Record<AgentFramework, Expected> = {
    'claude-code': {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configSubdir: '.claude'
    },
    codex: {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configSubdir: '.codex'
    },
    'gemini-cli': {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configSubdir: '.gemini'
    },
    openclaw: {
        kind: 'service',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configSubdir: null
    },
    hermes: {
        kind: 'service',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configSubdir: null
    },
    narranexus: {
        kind: 'service',
        runtimes: ['sprites', 'k8s'],
        configSubdir: null
    },
    dify: { kind: 'external', runtimes: ['external'], configSubdir: null },
    langflow: { kind: 'external', runtimes: ['external'], configSubdir: null },
    a2a: { kind: 'external', runtimes: ['external'], configSubdir: null }
}

const ALL_RUNTIMES: AgentRuntime[] = ['sprites', 'k8s', 'daemon', 'external']
const frameworks = Object.keys(GROUND_TRUTH) as AgentFramework[]

test('frameworkCapability reproduces kind / runtimes / configHome for every framework', () => {
    for (const f of frameworks) {
        const exp = GROUND_TRUTH[f]
        const cap = frameworkCapability(f)
        assert.equal(cap.kind, exp.kind, `${f} kind`)
        assert.deepEqual(
            [...cap.runtimes].sort(),
            [...exp.runtimes].sort(),
            `${f} runtimes`
        )
        assert.equal(
            cap.configHome?.subdir ?? null,
            exp.configSubdir,
            `${f} configHome.subdir`
        )
    }
})

test('supportsRuntime matches the support set for every (framework, runtime)', () => {
    for (const f of frameworks) {
        for (const r of ALL_RUNTIMES) {
            assert.equal(
                supportsRuntime(f, r),
                GROUND_TRUTH[f].runtimes.includes(r),
                `supportsRuntime(${f}, ${r})`
            )
        }
    }
})

test('isExternal is true only for external-kind frameworks', () => {
    for (const f of frameworks) {
        assert.equal(
            isExternal(f),
            GROUND_TRUTH[f].kind === 'external',
            `isExternal(${f})`
        )
    }
})

test('stepsFor reproduces the create-progress selector (external is the intentional fix)', () => {
    for (const f of frameworks) {
        const kind = GROUND_TRUTH[f].kind
        assert.deepEqual(
            stepsFor(f, 'external'),
            externalSteps,
            `stepsFor(${f}, external)`
        )
        assert.deepEqual(
            stepsFor(f, 'k8s'),
            kind === 'coding' ? k8sCliSteps : k8sSteps,
            `stepsFor(${f}, k8s)`
        )
        assert.deepEqual(
            stepsFor(f, 'sprites'),
            kind === 'service' ? spritesServiceSteps : spritesSteps,
            `stepsFor(${f}, sprites)`
        )
    }
})

test('frameworkCapabilities Record is exhaustive over the framework enum', () => {
    assert.equal(Object.keys(frameworkCapabilities).length, frameworks.length)
})