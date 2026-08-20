import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isPlatformTaskName,
    isServiceFrameworkName,
    PLATFORM_TASK_PREFIX
} from '../src/framework-capability'

// The host-detail "Services" surface must never let a user delete Manyfold's
// own framework services — deleting one breaks the agent it runs. Only
// service-kind framework names (which equal the on-sprite managed service name)
// are guarded; everything else is freely deletable.
test('service-kind framework names are managed (delete-protected)', () => {
    assert.equal(isServiceFrameworkName('hermes'), true)
    assert.equal(isServiceFrameworkName('openclaw'), true)
    assert.equal(isServiceFrameworkName('narranexus'), true)
})

test('hermes dashboard auxiliary services are managed (delete-protected)', () => {
    // Deleting either breaks the enabled dashboard topology: the proxy holds
    // the sprite's public http_port (chat routing), the dashboard serves the
    // web UI behind it.
    assert.equal(isServiceFrameworkName('hermes-dashboard'), true)
    assert.equal(isServiceFrameworkName('hermes-proxy'), true)
})

test('coding frameworks and agent-registered service names are not managed', () => {
    assert.equal(isServiceFrameworkName('claude-code'), false)
    assert.equal(isServiceFrameworkName('codex'), false)
    assert.equal(isServiceFrameworkName('gemini-cli'), false)
    // An agent-self-registered service (e.g. an http.server "deck") is the whole
    // point of the feature — it must be deletable.
    assert.equal(isServiceFrameworkName('deck'), false)
    assert.equal(isServiceFrameworkName(''), false)
    // Object prototype keys must not leak through as "managed".
    assert.equal(isServiceFrameworkName('toString'), false)
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
    assert.equal(isPlatformTaskName('narranexus-keepalive'), true)
})

test('agent-registered task names are deletable', () => {
    assert.equal(isPlatformTaskName('my-http-server'), false)
    // Coding frameworks never run a keep-alive service loop; only service-kind
    // legacy names are reserved.
    assert.equal(isPlatformTaskName('claude-code-keepalive'), false)
    assert.equal(isPlatformTaskName(''), false)
    assert.equal(isPlatformTaskName('toString'), false)
})
