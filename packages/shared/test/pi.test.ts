import assert from 'node:assert/strict'
import test from 'node:test'
import {
    PI_API_KEY_ENV,
    PI_PROVIDERS,
    isOfficialPiBaseUrl,
    isPiProtocol,
    piBareModelId,
    piProviderForProtocol,
    piQualifiedModel
} from '../src/pi'
import { frameworkSupportsProtocol } from '../src/inference-protocol'
import { INFERENCE_PROTOCOLS } from '../src/dtos'

test('exactly the three native protocols map to a pi provider, and the gate agrees', () => {
    assert.equal(piProviderForProtocol('anthropic_messages'), 'anthropic')
    assert.equal(piProviderForProtocol('openai_responses'), 'openai')
    assert.equal(piProviderForProtocol('google_generate_content'), 'google')
    for (const protocol of INFERENCE_PROTOCOLS)
        assert.equal(
            frameworkSupportsProtocol('pi', protocol),
            isPiProtocol(protocol),
            protocol
        )
    assert.equal(isPiProtocol('openai_chat_completions'), false)
    assert.equal(isPiProtocol('mistral_chat_completions'), false)
})

test('every pi provider names the env var pi reads its key from', () => {
    for (const provider of PI_PROVIDERS)
        assert.match(PI_API_KEY_ENV[provider], /_API_KEY$/)
})

test('the official base URL is recognised with or without a trailing slash, or unset', () => {
    assert.equal(isOfficialPiBaseUrl('anthropic', undefined), true)
    assert.equal(isOfficialPiBaseUrl('anthropic', '  '), true)
    assert.equal(
        isOfficialPiBaseUrl('anthropic', 'https://api.anthropic.com/'),
        true
    )
    assert.equal(
        isOfficialPiBaseUrl('openai', 'https://API.openai.com/v1'),
        true
    )
    assert.equal(isOfficialPiBaseUrl('openai', 'https://gw.example/v1'), false)
})

test('a model id is always handed to pi qualified with the credential provider', () => {
    assert.deepEqual(piQualifiedModel(null, 'anthropic'), {
        model: 'anthropic/claude-sonnet-4-6',
        providerMismatch: null
    })
    assert.deepEqual(piQualifiedModel(' gpt-5.5 ', 'openai'), {
        model: 'openai/gpt-5.5',
        providerMismatch: null
    })
    assert.deepEqual(piQualifiedModel('google/gemini-2.5-pro', 'google'), {
        model: 'google/gemini-2.5-pro',
        providerMismatch: null
    })
    assert.deepEqual(piQualifiedModel('openai/gpt-5.5', 'anthropic'), {
        model: 'openai/gpt-5.5',
        providerMismatch: 'openai'
    })
    assert.equal(piBareModelId('anthropic/claude-opus-4-7'), 'claude-opus-4-7')
    assert.equal(piBareModelId('claude-opus-4-7'), 'claude-opus-4-7')
})
