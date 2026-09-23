import test from 'node:test'
import assert from 'node:assert/strict'
import { heartbeatProblem, heartbeatReporter } from '../src/daemon/heartbeat'

test('a heartbeat the API turns away is described by its status and envelope only', async () => {
    assert.equal(
        await heartbeatProblem(new Response('{"ok":true}', { status: 200 })),
        null
    )
    assert.equal(
        await heartbeatProblem(
            new Response(
                JSON.stringify({
                    ok: false,
                    error: { code: 'unauthorized', message: 'token revoked' }
                }),
                { status: 401 }
            )
        ),
        'heartbeat rejected: HTTP 401 unauthorized (token revoked)'
    )
    const proxyPage = await heartbeatProblem(
        new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502
        })
    )
    assert.equal(proxyPage, 'heartbeat rejected: HTTP 502 internal_error')
})

test('a lasting heartbeat problem is logged once, and once more when it clears', async () => {
    const lines: string[] = []
    const report = heartbeatReporter((line) => {
        lines.push(line)
    })
    await report(null)
    await report('heartbeat rejected: HTTP 401 unauthorized (token revoked)')
    await report('heartbeat rejected: HTTP 401 unauthorized (token revoked)')
    await report('heartbeat failed: fetch failed')
    await report(null)
    await report(null)
    assert.deepEqual(lines, [
        'heartbeat rejected: HTTP 401 unauthorized (token revoked)',
        'heartbeat failed: fetch failed',
        'heartbeat ok again'
    ])
})
