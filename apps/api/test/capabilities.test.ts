import assert from 'node:assert/strict'
import test from 'node:test'
import { CapabilitiesRegistry } from '../src/common/capabilities/capabilities.registry'
import { CapabilitiesController } from '../src/modules/config/capabilities.controller'

test('capabilities: static registration reads true', async () => {
    const registry = new CapabilitiesRegistry()
    registry.register('daemonRuntime')
    assert.deepEqual(await registry.snapshot(), { daemonRuntime: true })
})

test('capabilities: probes are evaluated per snapshot', async () => {
    const registry = new CapabilitiesRegistry()
    let configured = false
    registry.register('k8sGateway', () => configured)
    assert.equal((await registry.snapshot()).k8sGateway, false)
    configured = true
    assert.equal((await registry.snapshot()).k8sGateway, true)
})

test('capabilities: a throwing probe reads unavailable, not an error', async () => {
    const registry = new CapabilitiesRegistry()
    registry.register('outboundEmail', () => {
        throw new Error('settings table unreachable')
    })
    assert.equal((await registry.snapshot()).outboundEmail, false)
})

test('capabilities: duplicate registration is a programming error', () => {
    const registry = new CapabilitiesRegistry()
    registry.register('billing')
    assert.throws(() => registry.register('billing'), /registered twice/)
})

test('capabilities: snapshot keys are sorted for stable payloads', async () => {
    const registry = new CapabilitiesRegistry()
    registry.register('zebra')
    registry.register('billing')
    registry.register('daemonRuntime')
    assert.deepEqual(Object.keys(await registry.snapshot()), [
        'billing',
        'daemonRuntime',
        'zebra'
    ])
})

test('capabilities endpoint: edition derives from module presence, informational only', async () => {
    const registry = new CapabilitiesRegistry()
    registry.register('daemonRuntime')
    const config = { get: () => undefined }
    const controller = new CapabilitiesController(registry, config as never)
    const oss = await controller.capabilities()
    assert.equal(oss.edition, 'self-hosted')
    assert.deepEqual(oss.features, { daemonRuntime: true })
    assert.equal(oss.branding.name, 'Manyfold')

    registry.register('billing')
    const cloud = await controller.capabilities()
    assert.equal(cloud.edition, 'cloud')
})

test('capabilities endpoint: reports presence only — no pricing-shaped keys', async () => {
    const registry = new CapabilitiesRegistry()
    registry.register('billing')
    const config = { get: () => 'https://app.example' }
    const controller = new CapabilitiesController(registry, config as never)
    const body = await controller.capabilities()
    const flat = JSON.stringify(body).toLowerCase()
    for (const banned of ['price', 'plan', 'usd', 'stripe'])
        assert.ok(!flat.includes(banned), `payload leaked '${banned}'`)
    assert.equal(typeof body.features.billing, 'boolean')
})
