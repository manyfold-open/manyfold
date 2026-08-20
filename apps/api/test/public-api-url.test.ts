import assert from 'node:assert/strict'
import test from 'node:test'
import { publicApiUrlWithApiPrefix } from '../src/common/public-api-url'

test('publicApiUrlWithApiPrefix appends /api to the public origin', () => {
    assert.equal(
        publicApiUrlWithApiPrefix('https://api.example.com'),
        'https://api.example.com/api'
    )
    assert.equal(
        publicApiUrlWithApiPrefix('https://api.manyfold.ai/'),
        'https://api.manyfold.ai/api'
    )
})

test('publicApiUrlWithApiPrefix tolerates an already-prefixed value', () => {
    assert.equal(
        publicApiUrlWithApiPrefix('https://api.manyfold.ai/api'),
        'https://api.manyfold.ai/api'
    )
    assert.equal(
        publicApiUrlWithApiPrefix('https://api.manyfold.ai/api/'),
        'https://api.manyfold.ai/api'
    )
})
