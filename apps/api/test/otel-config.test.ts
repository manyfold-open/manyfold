import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveOtelConfig } from '../src/otel-config'

test('otel config disables export when token is absent', () => {
    const config = resolveOtelConfig({ FLY_APP_NAME: 'example-api' })

    assert.equal(config.enabled, false)
    assert.equal(config.disabledReason, 'AXIOM_API_TOKEN is empty')
})

test('otel config blocks local export even when a token is present', () => {
    const config = resolveOtelConfig({
        AXIOM_API_TOKEN: 'test-token',
        AXIOM_DATASET: 'example-otel'
    })

    assert.equal(config.deploymentEnvironment, 'local')
    assert.equal(config.enabled, false)
    assert.equal(
        config.disabledReason,
        'local environment cannot export to Axiom'
    )
})

test('otel config enables export on Fly deployments', () => {
    const config = resolveOtelConfig({
        AXIOM_API_TOKEN: 'test-token',
        AXIOM_DATASET: 'example-otel',
        FLY_APP_NAME: 'example-api',
        MF_DEPLOY_ENV: 'production',
        MF_VERSION: '0.45.1'
    })

    assert.equal(config.enabled, true)
    assert.equal(config.deploymentEnvironment, 'production')
    assert.equal(config.serviceVersion, '0.45.1')
    assert.equal(config.disabledReason, null)
})

test('otel config uses the API package version when no override is set', () => {
    const config = resolveOtelConfig({
        FLY_APP_NAME: 'example-api-staging',
        MF_DEPLOY_ENV: 'staging'
    })

    assert.notEqual(config.serviceVersion, '0.0.0')
    assert.match(config.serviceVersion, /^\d+\.\d+\.\d+/)
})

test('otel config still blocks local export when extra local flags are present', () => {
    const config = resolveOtelConfig({
        AXIOM_API_TOKEN: 'test-token',
        AXIOM_ALLOW_LOCAL_EXPORT: 'true'
    })

    assert.equal(config.enabled, false)
    assert.equal(config.deploymentEnvironment, 'local')
})
