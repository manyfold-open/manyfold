import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSafeUrl } from '../src/url-guard'

test('blocks loopback, link-local metadata, and private ranges', async () => {
    await assert.rejects(() =>
        assertSafeUrl('http://127.0.0.1:8080/rpc', { allowHttp: true })
    )
    await assert.rejects(() =>
        assertSafeUrl('https://169.254.169.254/latest/meta-data')
    )
    await assert.rejects(() =>
        assertSafeUrl('http://[::1]:3000/rpc', { allowHttp: true })
    )
    await assert.rejects(() => assertSafeUrl('https://10.0.0.5/rpc'))
    await assert.rejects(() => assertSafeUrl('https://192.168.1.10/rpc'))
    await assert.rejects(() => assertSafeUrl('https://localhost/rpc'))
    await assert.rejects(() =>
        assertSafeUrl('https://metadata.google.internal/rpc')
    )
})

test('allows a public IP literal without DNS', async () => {
    assert.equal(await assertSafeUrl('https://8.8.8.8/rpc'), 'https://8.8.8.8/rpc')
})

test('IPv4-mapped IPv6 obeys the IPv4 private and reserved ranges', async () => {
    for (const address of [
        '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
        '::ffff:169.254.169.254', '::ffff:10.0.0.1', '::ffff:192.168.1.1',
        '::ffff:172.16.0.1', '::ffff:100.64.0.1', '::ffff:0.0.0.0',
        '::ffff:224.0.0.1', '::ffff:198.51.100.1'
    ])
        await assert.rejects(
            assertSafeUrl(`http://[${address}]/rpc`, { allowHttp: true }),
            /private or reserved/
        )
    assert.equal(await assertSafeUrl('https://[::ffff:8.8.8.8]/rpc'),
        'https://[::ffff:808:808]/rpc')
    assert.equal(await assertSafeUrl('http://[::ffff:127.0.0.1]/rpc', { allowPrivate: true }),
        'http://[::ffff:7f00:1]/rpc')
})

test('allowPrivate bypass enables local dev targets', async () => {
    assert.equal(
        await assertSafeUrl('http://127.0.0.1:8080/rpc', { allowPrivate: true }),
        'http://127.0.0.1:8080/rpc'
    )
})

test('rejects non-http(s), embedded credentials, and bare http', async () => {
    await assert.rejects(() => assertSafeUrl('ftp://example.com'))
    await assert.rejects(() => assertSafeUrl('https://user:pass@8.8.8.8/rpc'))
    await assert.rejects(() => assertSafeUrl('http://8.8.8.8/rpc'))
})
