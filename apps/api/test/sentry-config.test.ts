import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSentryConfig } from '../src/sentry-config'
import apiPackage from '../package.json'

test('no DSN disables Sentry and says why', () => {
    // The whole integration is opt-in: a repo without a DSN must behave
    // exactly as it did before Sentry existed.
    const config = resolveSentryConfig({})
    assert.equal(config.enabled, false)
    assert.equal(config.disabledReason, 'SENTRY_DSN is empty')

    assert.equal(resolveSentryConfig({ SENTRY_DSN: '   ' }).enabled, false)
})

test('a DSN enables Sentry even locally, tagged environment=local', () => {
    // Deliberately unlike Axiom, which refuses to run without FLY_APP_NAME:
    // setting a DSN by hand is how the integration gets verified end to end,
    // and environment=local keeps those events out of the deployed ones.
    const config = resolveSentryConfig({ SENTRY_DSN: 'https://k@o0.test/1' })
    assert.equal(config.enabled, true)
    assert.equal(config.disabledReason, null)
    assert.equal(config.environment, 'local')
})

test('environment follows MF_DEPLOY_ENV, then FLY_APP_NAME', () => {
    // Must match the deployment.environment Axiom already records, or the two
    // vendors disagree about which environment an incident belongs to.
    assert.equal(
        resolveSentryConfig({
            SENTRY_DSN: 'https://k@o0.test/1',
            MF_DEPLOY_ENV: 'production',
            FLY_APP_NAME: 'example-api'
        }).environment,
        'production'
    )
    assert.equal(
        resolveSentryConfig({
            SENTRY_DSN: 'https://k@o0.test/1',
            FLY_APP_NAME: 'example-api-staging'
        }).environment,
        'example-api-staging'
    )
})

test('release is api@<version>, overridable by MF_VERSION/NCA_VERSION', () => {
    assert.equal(
        resolveSentryConfig({ SENTRY_DSN: 'https://k@o0.test/1' }).release,
        `api@${apiPackage.version}`
    )
    assert.equal(
        resolveSentryConfig({
            SENTRY_DSN: 'https://k@o0.test/1',
            MF_VERSION: '1.2.3'
        }).release,
        'api@1.2.3'
    )
    assert.equal(
        resolveSentryConfig({
            SENTRY_DSN: 'https://k@o0.test/1',
            NCA_VERSION: '4.5.6'
        }).release,
        'api@4.5.6'
    )
})

test('traces sample rate defaults low in production only', () => {
    const rate = (env: Record<string, string | undefined>): number =>
        resolveSentryConfig({ SENTRY_DSN: 'https://k@o0.test/1', ...env })
            .tracesSampleRate

    assert.equal(rate({ MF_DEPLOY_ENV: 'production' }), 0.25)
    // staging traffic is tiny; sampling it down would leave no signal at all
    assert.equal(rate({ MF_DEPLOY_ENV: 'staging' }), 1)
    assert.equal(rate({}), 1)
})

test('an explicit sample rate is parsed and clamped', () => {
    const rate = (value: string, env = {}): number =>
        resolveSentryConfig({
            SENTRY_DSN: 'https://k@o0.test/1',
            SENTRY_TRACES_SAMPLE_RATE: value,
            ...env
        }).tracesSampleRate

    assert.equal(rate('0.5'), 0.5)
    assert.equal(rate('0'), 0)
    assert.equal(rate('  0.75  '), 0.75)
    assert.equal(rate('5'), 1)
    assert.equal(rate('-1'), 0)
    // a typo must not silently mean "send nothing"; fall back to the default
    assert.equal(rate('abc', { MF_DEPLOY_ENV: 'production' }), 0.25)
    assert.equal(rate('', { MF_DEPLOY_ENV: 'production' }), 0.25)
})