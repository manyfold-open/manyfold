import {
    RuntimePlacement,
    CoreFramework,
    externalSteps,
    frameworkCapability,
    isExternal,
    k8sSteps,
    listFrameworks,
    spritesServiceSteps,
    spritesSteps,
    stepsFor,
    supportsRuntime
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'

// ADR-0006 behaviour-preserving snapshot. The framework-capability module must
// reproduce the answer every migrated call site computed before the refactor.
// stepsFor is the exception: its lists follow what each create path emits
// (see agent-progress.ts), which the create tests check step by step.

interface Expected {
    kind: 'coding' | 'service' | 'external'
    runtimes: RuntimePlacement[]
    configSubdir: string | null
}

const GROUND_TRUTH: Record<CoreFramework, Expected> = {
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
    pi: {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configSubdir: '.pi'
    },
    'antigravity-cli': {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configSubdir: '.gemini/antigravity-cli'
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
    dify: { kind: 'external', runtimes: ['external'], configSubdir: null },
    langflow: { kind: 'external', runtimes: ['external'], configSubdir: null },
    a2a: { kind: 'external', runtimes: ['external'], configSubdir: null }
}

const ALL_RUNTIMES: RuntimePlacement[] = ['sprites', 'k8s', 'daemon', 'external']
const frameworks = Object.keys(GROUND_TRUTH) as CoreFramework[]

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

test('stepsFor picks the list by placement, and on a sandbox by framework kind', () => {
    for (const f of frameworks) {
        const kind = GROUND_TRUTH[f].kind
        assert.deepEqual(
            stepsFor(f, 'external'),
            externalSteps,
            `stepsFor(${f}, external)`
        )
        // A pod host installs every framework the same way (ADR-0035).
        assert.deepEqual(stepsFor(f, 'k8s'), k8sSteps, `stepsFor(${f}, k8s)`)
        assert.deepEqual(
            stepsFor(f, 'sprites'),
            kind === 'service' ? spritesServiceSteps : spritesSteps,
            `stepsFor(${f}, sprites)`
        )
    }
})

test('the ground truth covers every framework this build registers', () => {
    assert.deepEqual([...listFrameworks()].sort(), [...frameworks].sort())
})