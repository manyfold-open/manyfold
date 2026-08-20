import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExternalProviderEndpoint } from '../src/modules/user-external-agent-providers/endpoint-safety'

const ENV = 'MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS'
const LEGACY_ENV = 'NCA_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS'

test('external provider endpoint normalization rejects private targets by default', async () => {
    const previous = process.env[ENV]
    const previousLegacy = process.env[LEGACY_ENV]
    delete process.env[ENV]
    delete process.env[LEGACY_ENV]
    try {
        await assert.rejects(() =>
            normalizeExternalProviderEndpoint('http://localhost:7860')
        )
        await assert.rejects(() =>
            normalizeExternalProviderEndpoint('http://169.254.169.254/latest')
        )
        await assert.rejects(() =>
            normalizeExternalProviderEndpoint(
                'http://metadata.google.internal/computeMetadata/v1'
            )
        )
    } finally {
        if (previous === undefined) delete process.env[ENV]
        else process.env[ENV] = previous
        if (previousLegacy === undefined) delete process.env[LEGACY_ENV]
        else process.env[LEGACY_ENV] = previousLegacy
    }
})

test('external provider endpoint normalization allows public http urls', async () => {
    const previous = process.env[ENV]
    const previousLegacy = process.env[LEGACY_ENV]
    delete process.env[ENV]
    delete process.env[LEGACY_ENV]
    try {
        assert.equal(
            await normalizeExternalProviderEndpoint('https://8.8.8.8/v1/'),
            'https://8.8.8.8/v1'
        )
    } finally {
        if (previous === undefined) delete process.env[ENV]
        else process.env[ENV] = previous
        if (previousLegacy === undefined) delete process.env[LEGACY_ENV]
        else process.env[LEGACY_ENV] = previousLegacy
    }
})

test('external provider endpoint normalization can opt into local dev endpoints', async () => {
    const previous = process.env[ENV]
    const previousLegacy = process.env[LEGACY_ENV]
    delete process.env[LEGACY_ENV]
    process.env[ENV] = '1'
    try {
        assert.equal(
            await normalizeExternalProviderEndpoint('http://localhost:7860/'),
            'http://localhost:7860'
        )
    } finally {
        if (previous === undefined) delete process.env[ENV]
        else process.env[ENV] = previous
        if (previousLegacy === undefined) delete process.env[LEGACY_ENV]
        else process.env[LEGACY_ENV] = previousLegacy
    }
})

test('external provider endpoint normalization accepts legacy local dev env', async () => {
    const previousNew = process.env[ENV]
    const previous = process.env[LEGACY_ENV]
    delete process.env[ENV]
    process.env[LEGACY_ENV] = '1'
    try {
        assert.equal(
            await normalizeExternalProviderEndpoint('http://localhost:7860/'),
            'http://localhost:7860'
        )
    } finally {
        if (previousNew === undefined) delete process.env[ENV]
        else process.env[ENV] = previousNew
        if (previous === undefined) delete process.env[LEGACY_ENV]
        else process.env[LEGACY_ENV] = previous
    }
})
