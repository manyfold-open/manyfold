import assert from 'node:assert/strict'
import test from 'node:test'
import {
    publicApiUrlWithApiPrefix,
    reachableFromOutside,
    runnerApiUrl
} from '../src/common/public-api-url'

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

// What a sandbox's runner is told to call. The bring-up used to append /api
// itself, so a PUBLIC_API_BASE_URL already ending in /api became /api/api.
test('runnerApiUrl adds /api once, and falls back to the hosted API', (t) => {
    const prior = process.env.PUBLIC_API_BASE_URL
    t.after(() => {
        if (prior === undefined) delete process.env.PUBLIC_API_BASE_URL
        else process.env.PUBLIC_API_BASE_URL = prior
    })
    process.env.PUBLIC_API_BASE_URL = 'https://tunnel.example.com/api'
    assert.equal(runnerApiUrl(), 'https://tunnel.example.com/api')
    process.env.PUBLIC_API_BASE_URL = 'https://tunnel.example.com/'
    assert.equal(runnerApiUrl(), 'https://tunnel.example.com/api')
    delete process.env.PUBLIC_API_BASE_URL
    assert.equal(runnerApiUrl(), 'https://api.manyfold.ai/api')
})

test('reachableFromOutside refuses addresses no remote machine can open', () => {
    for (const url of [
        'http://localhost:7110/api',
        'http://api.localhost/api',
        'http://my-mac.local:2222/api',
        'http://127.0.0.1:2222/api',
        'http://[::1]:2222/api',
        'http://10.0.0.5/api',
        'http://172.20.1.1/api',
        'http://192.168.1.20:2222/api',
        'http://169.254.169.254/api',
        'http://100.64.0.1/api',
        'not a url'
    ])
        assert.equal(reachableFromOutside(url), false, url)
    for (const url of [
        'https://api.manyfold.ai/api',
        'https://income-compiled-always-circuit.trycloudflare.com/api',
        'http://203.0.114.10:2222/api',
        'http://my-server.example.com/api'
    ])
        assert.equal(reachableFromOutside(url), true, url)
})
