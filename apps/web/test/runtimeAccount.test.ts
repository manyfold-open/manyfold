import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeAccountView } from '@manyfold/shared'
import en from '../../../packages/i18n/src/langs/en'
import {
    formatResetsIn,
    planLabel,
    signInNeeded,
    usageTone,
    usageWindowLabelKey
} from '../src/lib/runtimeAccount'

const view = (patch: Partial<RuntimeAccountView> = {}): RuntimeAccountView => ({
    runtimeId: 'art_1',
    framework: 'codex',
    kind: 'daemon',
    status: 'ok',
    checkedAt: '2026-09-03T10:00:00.000Z',
    credentialStatus: 'valid',
    credentialReason: 'oauth-live',
    tokenSource: 'file',
    identity: null,
    usage: null,
    host: null,
    error: null,
    ...patch
})

test('every vendor window key the mapper emits has a label in the English catalog', () => {
    const account = (
        en.web as { runtimeDetails: { account: Record<string, string> } }
    ).runtimeDetails.account
    for (const key of [
        'five_hour',
        'seven_day',
        'seven_day_opus',
        'seven_day_sonnet',
        'gemini_pro',
        'gemini_flash',
        'gemini_flash_lite'
    ]) {
        const labelKey = usageWindowLabelKey(key)
        assert.ok(labelKey, key)
        const leaf = labelKey.split('.').pop() ?? ''
        assert.ok(account[leaf], `${labelKey} missing from en catalog`)
    }
    // A Gemini model id outside the known families renders as itself.
    assert.equal(usageWindowLabelKey('gemini-3.5-ultra'), null)
})

test('bar tone tracks how close a window is to refusing requests', () => {
    assert.equal(usageTone(0), 'success')
    assert.equal(usageTone(69), 'success')
    assert.equal(usageTone(70), 'warning')
    assert.equal(usageTone(89), 'warning')
    assert.equal(usageTone(90), 'error')
    assert.equal(usageTone(100), 'error')
})

test('reset countdowns never go negative and skip unparsable timestamps', () => {
    const now = Date.parse('2026-09-03T10:00:00.000Z')
    assert.equal(formatResetsIn('2026-09-03T12:30:00.000Z', now), '2.5h')
    assert.equal(formatResetsIn('2026-09-03T09:00:00.000Z', now), '0ms')
    assert.equal(formatResetsIn('garbage', now), null)
    assert.equal(formatResetsIn(null, now), null)
})

test('plan labels read as words without the vendor prefixes', () => {
    assert.equal(planLabel('default_claude_max_5x'), 'Max 5x')
    assert.equal(planLabel('claude_team'), 'Team')
    assert.equal(planLabel('chatgpt_business'), 'Business')
    assert.equal(planLabel('pro'), 'Pro')
    assert.equal(planLabel('team_tier_1'), 'Team Tier 1')
    assert.equal(planLabel('  '), null)
    assert.equal(planLabel(null), null)
})

test('sign-in is offered for missing, expired or rejected sign-ins only', () => {
    assert.equal(signInNeeded(view({ credentialStatus: 'missing' })), true)
    assert.equal(signInNeeded(view({ credentialStatus: 'expired' })), true)
    assert.equal(
        signInNeeded(
            view({
                usage: {
                    windows: [],
                    plan: null,
                    fetchedAt: '2026-09-03T10:00:00.000Z',
                    error: {
                        kind: 'unauthorized',
                        retryAfterSeconds: null,
                        message: null
                    }
                }
            })
        ),
        true
    )
    // Signed in by API key: no vendor account, nothing to sign in to.
    assert.equal(
        signInNeeded(
            view({
                credentialReason: 'api-key',
                tokenSource: 'none'
            })
        ),
        false
    )
    assert.equal(signInNeeded(view()), false)
    // Not-yet-probed states never show the button.
    assert.equal(
        signInNeeded(view({ status: 'sandbox-asleep', credentialStatus: 'missing' })),
        false
    )
})
