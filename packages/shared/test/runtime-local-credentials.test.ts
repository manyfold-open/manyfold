import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    isRuntimeLocalCredentialUsable,
    parseRuntimeLocalCredentialFacts,
    runtimeLocalCredentialStatus,
    type ClaudeCredentialFacts,
    type CodexCredentialFacts,
    type GeminiCredentialFacts
} from '../src/runtime-local-credentials'

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0)
const HOUR = 3_600_000

const claude = (
    overrides: Partial<ClaudeCredentialFacts> = {}
): ClaudeCredentialFacts => ({
    framework: 'claude-code',
    envToken: false,
    credentialsFileParsed: false,
    oauthExpiresAt: null,
    hasRefreshToken: false,
    oauthAccount: false,
    configPresent: false,
    ...overrides
})

const codex = (
    overrides: Partial<CodexCredentialFacts> = {}
): CodexCredentialFacts => ({
    framework: 'codex',
    authFilePresent: false,
    authFileParsed: false,
    apiKeyPresent: false,
    envApiKey: false,
    hasAccessToken: false,
    hasRefreshToken: false,
    accessTokenExp: null,
    lastRefresh: null,
    customProviders: [],
    activeProvider: null,
    ...overrides
})

const gemini = (
    overrides: Partial<GeminiCredentialFacts> = {}
): GeminiCredentialFacts => ({
    framework: 'gemini-cli',
    envApiKey: false,
    settingsApiKey: false,
    oauthFilePresent: false,
    oauthFileParsed: false,
    oauthExpiryDate: null,
    hasRefreshToken: false,
    ...overrides
})

describe('runtimeLocalCredentialStatus — claude-code', () => {
    it('accepts an env token without touching files', () => {
        const result = runtimeLocalCredentialStatus(
            claude({ envToken: true }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'env-token')
    })

    it('accepts a live oauth token', () => {
        const result = runtimeLocalCredentialStatus(
            claude({
                credentialsFileParsed: true,
                oauthExpiresAt: NOW + HOUR
            }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'oauth-live')
    })

    it('reports an expired oauth token with no refresh token', () => {
        const result = runtimeLocalCredentialStatus(
            claude({
                credentialsFileParsed: true,
                oauthExpiresAt: NOW - HOUR,
                configPresent: true
            }),
            NOW
        )
        assert.equal(result.status, 'expired')
        assert.equal(result.reason, 'oauth-expired')
    })

    it('keeps an expired oauth token valid when it can refresh', () => {
        const result = runtimeLocalCredentialStatus(
            claude({
                credentialsFileParsed: true,
                oauthExpiresAt: NOW - HOUR,
                hasRefreshToken: true
            }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'oauth-refreshable')
    })

    it('treats the macOS login record as valid', () => {
        const result = runtimeLocalCredentialStatus(
            claude({ oauthAccount: true, configPresent: true }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'login-record')
    })

    it('stays unknown when only an unreadable config is present', () => {
        const result = runtimeLocalCredentialStatus(
            claude({ configPresent: true }),
            NOW
        )
        assert.equal(result.status, 'unknown')
        assert.ok(isRuntimeLocalCredentialUsable(result.status))
    })

    it('reports missing when no credential trace exists at all', () => {
        const result = runtimeLocalCredentialStatus(claude(), NOW)
        assert.equal(result.status, 'missing')
        assert.equal(isRuntimeLocalCredentialUsable(result.status), false)
    })
})

describe('runtimeLocalCredentialStatus — codex', () => {
    it('accepts an auth.json API key', () => {
        const result = runtimeLocalCredentialStatus(
            codex({
                authFilePresent: true,
                authFileParsed: true,
                apiKeyPresent: true
            }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'api-key')
    })

    it('keeps an expired access token valid when a refresh token exists', () => {
        const result = runtimeLocalCredentialStatus(
            codex({
                authFilePresent: true,
                authFileParsed: true,
                hasAccessToken: true,
                hasRefreshToken: true,
                accessTokenExp: NOW - HOUR
            }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'oauth-refreshable')
    })

    it('reports an expired access token with no way to renew it', () => {
        const result = runtimeLocalCredentialStatus(
            codex({
                authFilePresent: true,
                authFileParsed: true,
                hasAccessToken: true,
                accessTokenExp: NOW - HOUR
            }),
            NOW
        )
        assert.equal(result.status, 'expired')
    })

    it('accepts a custom gateway whose env key is set', () => {
        const result = runtimeLocalCredentialStatus(
            codex({
                activeProvider: 'mygw',
                customProviders: [
                    {
                        id: 'mygw',
                        hasBaseUrl: true,
                        envKey: 'MYGW_KEY',
                        envKeyPresent: true,
                        requiresOpenaiAuth: false
                    }
                ]
            }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'custom-provider')
    })

    it('ignores a custom gateway that is not the selected provider', () => {
        const result = runtimeLocalCredentialStatus(
            codex({
                activeProvider: 'other',
                customProviders: [
                    {
                        id: 'mygw',
                        hasBaseUrl: true,
                        envKey: 'MYGW_KEY',
                        envKeyPresent: true,
                        requiresOpenaiAuth: false
                    }
                ]
            }),
            NOW
        )
        assert.equal(result.status, 'unknown')
    })

    it('reports missing when a readable auth.json holds no credentials', () => {
        const result = runtimeLocalCredentialStatus(
            codex({ authFilePresent: true, authFileParsed: true }),
            NOW
        )
        assert.equal(result.status, 'missing')
    })

    it('stays unknown when auth.json cannot be parsed', () => {
        const result = runtimeLocalCredentialStatus(
            codex({ authFilePresent: true }),
            NOW
        )
        assert.equal(result.status, 'unknown')
    })
})

describe('runtimeLocalCredentialStatus — gemini-cli', () => {
    it('accepts an env API key', () => {
        const result = runtimeLocalCredentialStatus(
            gemini({ envApiKey: true }),
            NOW
        )
        assert.equal(result.status, 'valid')
    })

    it('accepts a settings.json API key', () => {
        const result = runtimeLocalCredentialStatus(
            gemini({ settingsApiKey: true }),
            NOW
        )
        assert.equal(result.status, 'valid')
        assert.equal(result.reason, 'api-key')
    })

    it('reports an expired oauth file with no refresh token', () => {
        const result = runtimeLocalCredentialStatus(
            gemini({
                oauthFilePresent: true,
                oauthFileParsed: true,
                oauthExpiryDate: NOW - HOUR
            }),
            NOW
        )
        assert.equal(result.status, 'expired')
    })

    it('keeps an expired oauth file valid when it can refresh', () => {
        const result = runtimeLocalCredentialStatus(
            gemini({
                oauthFilePresent: true,
                oauthFileParsed: true,
                oauthExpiryDate: NOW - HOUR,
                hasRefreshToken: true
            }),
            NOW
        )
        assert.equal(result.status, 'valid')
    })

    it('reports missing when nothing is configured', () => {
        assert.equal(runtimeLocalCredentialStatus(gemini(), NOW).status, 'missing')
    })
})

describe('runtimeLocalCredentialStatus — fleet compatibility', () => {
    it('fails open when a daemon reports no facts', () => {
        for (const value of [null, undefined]) {
            const result = runtimeLocalCredentialStatus(value, NOW)
            assert.equal(result.status, 'unknown')
            assert.equal(result.reason, 'not-reported')
            assert.ok(isRuntimeLocalCredentialUsable(result.status))
        }
    })

    it('re-evaluates the same facts against a later clock', () => {
        const facts = claude({
            credentialsFileParsed: true,
            oauthExpiresAt: NOW + HOUR,
            configPresent: true
        })
        assert.equal(runtimeLocalCredentialStatus(facts, NOW).status, 'valid')
        assert.equal(
            runtimeLocalCredentialStatus(facts, NOW + 2 * HOUR).status,
            'expired'
        )
    })

    // Callers hand this raw daemon JSON, where any field can be missing. A
    // missing expiry must never read as expired: that would fail closed on
    // exactly the runtimes we cannot judge.
    it('survives a partial payload from an unknown daemon build', () => {
        const partial = {
            framework: 'codex'
        } as unknown as CodexCredentialFacts
        assert.equal(
            runtimeLocalCredentialStatus(partial, NOW).status,
            'missing'
        )
        const partialClaude = {
            framework: 'claude-code'
        } as unknown as ClaudeCredentialFacts
        assert.equal(
            runtimeLocalCredentialStatus(partialClaude, NOW).status,
            'missing'
        )
        const partialGemini = {
            framework: 'gemini-cli'
        } as unknown as GeminiCredentialFacts
        assert.equal(
            runtimeLocalCredentialStatus(partialGemini, NOW).status,
            'missing'
        )
        const unknownFramework = {
            framework: 'something-new'
        } as unknown as CodexCredentialFacts
        assert.equal(
            runtimeLocalCredentialStatus(unknownFramework, NOW).status,
            'unknown'
        )
    })
})

describe('parseRuntimeLocalCredentialFacts', () => {
    it('round-trips claude facts from untyped json', () => {
        const parsed = parseRuntimeLocalCredentialFacts({
            framework: 'claude-code',
            envToken: true,
            oauthExpiresAt: 1234,
            hasRefreshToken: 'yes',
            configPresent: true
        })
        assert.deepEqual(parsed, {
            framework: 'claude-code',
            envToken: true,
            credentialsFileParsed: false,
            oauthExpiresAt: 1234,
            hasRefreshToken: false,
            oauthAccount: false,
            configPresent: true
        })
    })

    it('drops custom provider entries without an id', () => {
        const parsed = parseRuntimeLocalCredentialFacts({
            framework: 'codex',
            customProviders: [
                { hasBaseUrl: true },
                { id: 'gw', hasBaseUrl: true, envKeyPresent: true }
            ]
        }) as CodexCredentialFacts
        assert.equal(parsed.customProviders.length, 1)
        assert.equal(parsed.customProviders[0].id, 'gw')
    })

    it('rejects payloads from an unknown framework', () => {
        assert.equal(parseRuntimeLocalCredentialFacts({ framework: 'x' }), null)
        assert.equal(parseRuntimeLocalCredentialFacts(null), null)
        assert.equal(parseRuntimeLocalCredentialFacts('claude-code'), null)
    })
})
