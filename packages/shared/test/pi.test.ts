import assert from 'node:assert/strict'
import test from 'node:test'
import {
    PI_API_KEY_ENV,
    PI_PROVIDERS,
    isOfficialPiBaseUrl,
    isPiProtocol,
    piModelId,
    piProviderBaseUrl,
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
    // Stored the gemini-cli way (root) or the way pi itself names it.
    assert.equal(
        isOfficialPiBaseUrl(
            'google',
            'https://generativelanguage.googleapis.com'
        ),
        true
    )
    assert.equal(
        isOfficialPiBaseUrl(
            'google',
            'https://generativelanguage.googleapis.com/v1beta/'
        ),
        true
    )
})

test('a Gemini endpoint gets the API version pi does not append itself', () => {
    assert.equal(
        piProviderBaseUrl(
            'google',
            'https://api.netmind.ai/inference-api/gemini/'
        ),
        'https://api.netmind.ai/inference-api/gemini/v1beta'
    )
    assert.equal(
        piProviderBaseUrl('google', 'https://gw.example/v1'),
        'https://gw.example/v1'
    )
    assert.equal(
        piProviderBaseUrl(
            'anthropic',
            'https://api.netmind.ai/inference-api/anthropic/'
        ),
        'https://api.netmind.ai/inference-api/anthropic'
    )
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
    assert.equal(piModelId('anthropic/claude-opus-4-7'), 'claude-opus-4-7')
})

test('a gateway model id keeps its slashes and is never read as another vendor', () => {
    const gateway = 'https://api.netmind.ai/inference-api/openai/v1'
    assert.deepEqual(
        piQualifiedModel('openai/gpt-oss-120b', 'openai', gateway),
        {
            model: 'openai/openai/gpt-oss-120b',
            providerMismatch: null
        }
    )
    assert.deepEqual(
        piQualifiedModel('deepseek-ai/DeepSeek-V3', 'anthropic', gateway),
        { model: 'anthropic/deepseek-ai/DeepSeek-V3', providerMismatch: null }
    )
    assert.equal(
        piModelId('anthropic/deepseek-ai/DeepSeek-V3'),
        'deepseek-ai/DeepSeek-V3'
    )
    // On the vendor's own API an unknown prefix is still part of the id.
    assert.deepEqual(piQualifiedModel('deepseek-ai/DeepSeek-V3', 'anthropic'), {
        model: 'anthropic/deepseek-ai/DeepSeek-V3',
        providerMismatch: null
    })
})
