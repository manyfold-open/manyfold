import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AWAKE_KEEP_TASK_NAME,
    isAwakeHoldTaskName,
    isPlatformServiceName,
    isPlatformTaskName,
    PLATFORM_TASK_PREFIX
} from '../src/framework-capability'

// The sandbox "Services" surface must never let a user delete or stop the two
// services Manyfold registers on a sprite: the daemon's restart loop (every
// framework service runs under the daemon, so a stop takes them all down) and
// the stub routing the public URL. Everything else is the user's.
test('the daemon and the public port stub are platform services', () => {
    assert.equal(isPlatformServiceName('mf-daemon'), true)
    assert.equal(isPlatformServiceName('mf-port'), true)
})

test('framework and agent-registered service names are not platform services', () => {
    // Framework services run under the daemon, not the sprite's Services API.
    assert.equal(isPlatformServiceName('hermes'), false)
    assert.equal(isPlatformServiceName('openclaw'), false)
    // An agent-self-registered service (e.g. an http.server "deck") is the whole
    // point of the feature — it must be deletable.
    assert.equal(isPlatformServiceName('deck'), false)
    assert.equal(isPlatformServiceName(''), false)
    assert.equal(isPlatformServiceName('toString'), false)
})

// The Tasks surface's delete guard: platform keep-alive leases must be managed
// through the runtime keep-alive toggle — deleting them directly is either
// undone by reconcile (nca-*) or by the legacy fused renew loop
// (<framework>-keepalive), so both shapes are refused.
test('platform keep-alive task names are protected', () => {
    assert.equal(PLATFORM_TASK_PREFIX, 'nca-')
    assert.equal(isPlatformTaskName('nca-hermes-abc123-0f'), true)
    assert.equal(isPlatformTaskName('nca-codex-ab12cd-3'), true)
    assert.equal(isPlatformTaskName('hermes-keepalive'), true)
    assert.equal(isPlatformTaskName('openclaw-keepalive'), true)
})

test('agent-registered task names are deletable', () => {
    assert.equal(isPlatformTaskName('my-http-server'), false)
    // Coding frameworks never run a keep-alive service loop; only service-kind
    // legacy names are reserved.
    assert.equal(isPlatformTaskName('claude-code-keepalive'), false)
    assert.equal(isPlatformTaskName(''), false)
    assert.equal(isPlatformTaskName('toString'), false)
})

// An API instance's awake hold (ADR-0038) is the platform's too: listed as
// such, refused by the delete guard, and kept by a user's stop so work in
// progress is not frozen under it. Only the exact shape counts, so an agent
// task cannot pass for one by sharing the prefix.
test('awake hold task names are the platform exact shape', () => {
    assert.equal(isPlatformTaskName('mf-hold-0123abcd'), true)
    assert.equal(isAwakeHoldTaskName('mf-hold-0123abcd'), true)
    assert.equal(isAwakeHoldTaskName('mf-hold-0123abcd9'), false)
    assert.equal(isAwakeHoldTaskName('mf-hold-XYZ12345'), false)
    assert.equal(isPlatformTaskName('mf-hold-'), false)
    assert.equal(isPlatformTaskName('mf-agp2vxbm6vywzm6pt2xmxa6qi4-0123abcd'), false)
    assert.equal(isAwakeHoldTaskName('nca-host-abc-1-0f'), false)
})

// The keep-awake switch's hold is one per host, so only its exact name counts.
test('the keep-awake hold is the platform exact name', () => {
    assert.equal(AWAKE_KEEP_TASK_NAME, 'mf-keep')
    assert.equal(isPlatformTaskName('mf-keep'), true)
    assert.equal(isPlatformTaskName('mf-keep-1'), false)
    assert.equal(isPlatformTaskName('mf-keeper'), false)
})
