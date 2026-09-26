import assert from 'node:assert/strict'
import test from 'node:test'
import {
    antigravityUpstreamModel,
    frameworkResumeArgv,
    frameworkSupportsProtocol,
    isAntigravityConversationId,
    isModelConfigFramework,
    isRuntimeAuthProfileFramework,
    parseAntigravityModelList,
    parseRuntimeLocalCredentialFacts,
    runtimeAccountSupport,
    runtimeAuthSupported,
    runtimeLocalCredentialStatus,
    type AntigravityCliCredentialFacts
} from '../src'

// `agy models` on 1.2.11 in API-key mode (stdout; the progress line is on
// stderr, and is kept here to prove it is dropped).
const AGY_MODELS_STDOUT = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
`

test('the model list is the tab-separated slug lines only', () => {
    assert.deepEqual(parseAntigravityModelList(AGY_MODELS_STDOUT), [
        { slug: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { slug: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
        { slug: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
        { slug: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' }
    ])
    assert.deepEqual(parseAntigravityModelList('error: not signed in\n'), [])
})

test('a platform turn is billed under the Gemini API id agy calls', () => {
    assert.equal(
        antigravityUpstreamModel('gemini-3.8-flash-low'),
        'gemini-3.8-flash'
    )
    assert.equal(
        antigravityUpstreamModel('gemini-3.1-pro-high'),
        'gemini-3.1-pro-preview-customtools'
    )
    // agy's own default when no model is named
    assert.equal(antigravityUpstreamModel(null), 'gemini-3.1-pro-preview')
})

test('a stored ref is one of the conversation ids agy mints', () => {
    assert.equal(
        isAntigravityConversationId('6bce3054-1614-4b63-b9b5-9590cdfc8458'),
        true
    )
    assert.equal(isAntigravityConversationId('latest'), false)
    assert.equal(isAntigravityConversationId('../x'), false)
    assert.equal(isAntigravityConversationId(null), false)
})

test('Antigravity CLI keeps model settings but has no auth profiles', () => {
    assert.equal(isModelConfigFramework('antigravity-cli'), true)
    assert.equal(isRuntimeAuthProfileFramework('antigravity-cli'), false)
    // The ambient account probe still applies; profiles do not.
    assert.equal(runtimeAccountSupport('antigravity-cli', 'sprites'), 'ok')
    assert.equal(runtimeAuthSupported('antigravity-cli', 'sprites'), false)
    assert.equal(runtimeAuthSupported('antigravity-cli', 'daemon'), false)
    for (const framework of ['claude-code', 'codex', 'gemini-cli', 'pi'])
        assert.equal(runtimeAuthSupported(framework, 'daemon'), true, framework)
})

test('its API-key mode speaks only the Gemini protocol', () => {
    assert.equal(
        frameworkSupportsProtocol('antigravity-cli', 'google_generate_content'),
        true
    )
    assert.equal(
        frameworkSupportsProtocol('antigravity-cli', 'anthropic_messages'),
        false
    )
    assert.equal(
        frameworkSupportsProtocol('antigravity-cli', 'openai_responses'),
        false
    )
})

test('a conversation resumes with --conversation', () => {
    assert.deepEqual(
        frameworkResumeArgv(
            'antigravity-cli',
            ' 6bce3054-1614-4b63-b9b5-9590cdfc8458 '
        ),
        ['agy', '--conversation', '6bce3054-1614-4b63-b9b5-9590cdfc8458']
    )
})

const facts = (
    over: Partial<AntigravityCliCredentialFacts> = {}
): AntigravityCliCredentialFacts => ({
    framework: 'antigravity-cli',
    tokenFilePresent: false,
    tokenFileParsed: false,
    tokenExpiresAt: null,
    hasRefreshToken: false,
    settingsApiKeyMode: false,
    envApiKey: false,
    cliSignedIn: null,
    ...over
})

test('API-key mode is usable only with its key; without one agy will not start', () => {
    const now = Date.now()
    assert.deepEqual(
        runtimeLocalCredentialStatus(
            facts({ settingsApiKeyMode: true, envApiKey: true }),
            now
        ),
        { status: 'valid', reason: 'api-key' }
    )
    assert.deepEqual(
        runtimeLocalCredentialStatus(facts({ settingsApiKeyMode: true }), now),
        { status: 'missing', reason: 'no-credentials' }
    )
})

test('a file-backed sign-in is judged by its expiry, else by being there', () => {
    const now = Date.now()
    assert.deepEqual(
        runtimeLocalCredentialStatus(
            facts({
                tokenFilePresent: true,
                tokenFileParsed: true,
                tokenExpiresAt: now - 1000,
                hasRefreshToken: true
            }),
            now
        ),
        { status: 'valid', reason: 'oauth-refreshable' }
    )
    assert.deepEqual(
        runtimeLocalCredentialStatus(
            facts({ tokenFilePresent: true, tokenFileParsed: true }),
            now
        ),
        { status: 'valid', reason: 'login-record' }
    )
    assert.deepEqual(
        runtimeLocalCredentialStatus(facts({ tokenFilePresent: true }), now),
        { status: 'unknown', reason: 'unreadable' }
    )
})

test('agy’s own verdict outranks what its files suggest', () => {
    const now = Date.now()
    // A keychain sign-in leaves no file behind.
    assert.deepEqual(
        runtimeLocalCredentialStatus(facts({ cliSignedIn: true }), now, {
            configPresenceIsEvidence: false
        }),
        { status: 'valid', reason: 'login-record' }
    )
    // A token file agy refuses to use is no sign-in.
    assert.deepEqual(
        runtimeLocalCredentialStatus(
            facts({
                cliSignedIn: false,
                tokenFilePresent: true,
                tokenFileParsed: true,
                tokenExpiresAt: now + 60_000
            }),
            now
        ),
        { status: 'missing', reason: 'no-credentials' }
    )
})

test('undecided, only a machine that can hide a sign-in in a keyring earns the doubt', () => {
    const now = Date.now()
    assert.deepEqual(runtimeLocalCredentialStatus(facts(), now), {
        status: 'unknown',
        reason: 'unreadable'
    })
    assert.deepEqual(
        runtimeLocalCredentialStatus(facts(), now, {
            configPresenceIsEvidence: false
        }),
        { status: 'missing', reason: 'no-credentials' }
    )
})

test('credential facts are re-validated field by field', () => {
    assert.deepEqual(
        parseRuntimeLocalCredentialFacts({
            framework: 'antigravity-cli',
            tokenFilePresent: true,
            tokenFileParsed: 'yes',
            tokenExpiresAt: 'soon',
            envApiKey: true,
            cliSignedIn: 'yes'
        }),
        facts({ tokenFilePresent: true, envApiKey: true })
    )
    assert.equal(
        (
            parseRuntimeLocalCredentialFacts({
                framework: 'antigravity-cli',
                cliSignedIn: false
            }) as AntigravityCliCredentialFacts
        ).cliSignedIn,
        false
    )
})
