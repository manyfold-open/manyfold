import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv } from 'node:crypto'
import {
    aesEcbPaddedSize,
    decodeCdnDescriptor,
    downloadWeixinCdnMedia,
    encodeCdnDescriptor,
    parseAesKey,
    prepareWeixinUpload,
    sniffImageMime,
    weixinMediaAesKeyForWire
} from '../src/modules/channels/providers/weixin-cdn'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('sniffImageMime reads magic bytes', () => {
    assert.equal(sniffImageMime(jpeg), 'image/jpeg')
    assert.equal(sniffImageMime(png), 'image/png')
    assert.equal(
        sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])),
        'image/gif'
    )
    // Unknown → jpeg default.
    assert.equal(sniffImageMime(Buffer.from([0, 1, 2])), 'image/jpeg')
})

test('parseAesKey accepts raw-16, hex-32-base64, and raw hex', () => {
    const raw = Buffer.alloc(16, 7)
    assert.deepEqual(parseAesKey({ aesKeyBase64: raw.toString('base64') }), raw)
    const hex = raw.toString('hex') // 32 chars
    assert.deepEqual(
        parseAesKey({ aesKeyBase64: Buffer.from(hex, 'utf8').toString('base64') }),
        raw
    )
    assert.deepEqual(parseAesKey({ aesKeyHex: hex }), raw)
    assert.throws(() => parseAesKey({ aesKeyBase64: 'AAAA' }))
})

test('aesEcbPaddedSize pads to the next block including a full extra block', () => {
    assert.equal(aesEcbPaddedSize(0), 16)
    assert.equal(aesEcbPaddedSize(15), 16)
    assert.equal(aesEcbPaddedSize(16), 32)
    assert.equal(aesEcbPaddedSize(17), 32)
})

test('cdn descriptor round-trips through the sentinel encoding', () => {
    const d = {
        q: 'enc-param',
        u: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1',
        k: 'a2V5',
        name: 'image.jpg',
        contentType: 'image/jpeg'
    }
    const encoded = encodeCdnDescriptor(d)
    assert.ok(encoded.startsWith('weixin-cdn:'))
    assert.deepEqual(decodeCdnDescriptor(encoded), d)
    assert.equal(decodeCdnDescriptor('https://example.com'), null)
})

test('weixinMediaAesKeyForWire is base64 of the hex string (grey-block guard)', () => {
    const hex = '00112233445566778899aabbccddeeff'
    assert.equal(
        weixinMediaAesKeyForWire(hex),
        Buffer.from(hex, 'utf8').toString('base64')
    )
})

test('downloadWeixinCdnMedia decrypts AES-128-ECB from an allowed host', async (t) => {
    // Encrypt a known payload the same way the outbound path does, then serve
    // it back as the CDN would and confirm the download decrypts it.
    const plaintext = Buffer.concat([jpeg, Buffer.alloc(40, 9)])
    const plan = prepareWeixinUpload(plaintext)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        assert.match(url, /novac2c\.cdn\.weixin\.qq\.com/)
        return new Response(new Uint8Array(plan.ciphertext).buffer, {
            status: 200
        })
    }) as typeof fetch

    const result = await downloadWeixinCdnMedia(
        {
            u: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1',
            ak: plan.aesKeyHex,
            name: 'image.jpg',
            contentType: 'image/jpeg'
        },
        'https://novac2c.cdn.weixin.qq.com/c2c',
        10 * 1024 * 1024
    )
    assert.deepEqual(result.bytes, plaintext)
    // Content type re-sniffed from the decrypted bytes.
    assert.equal(result.contentType, 'image/jpeg')
})

test('downloadWeixinCdnMedia rejects a non-allowlisted host (SSRF guard)', async (t) => {
    const originalFetch = globalThis.fetch
    let fetched = false
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () => {
        fetched = true
        return new Response('nope', { status: 200 })
    }) as typeof fetch

    await assert.rejects(
        downloadWeixinCdnMedia(
            {
                u: 'https://evil.example.com/steal',
                ak: '00112233445566778899aabbccddeeff',
                name: 'x',
                contentType: 'image/jpeg'
            },
            'https://novac2c.cdn.weixin.qq.com/c2c',
            1024
        ),
        /host not allowed/
    )
    assert.equal(fetched, false)
})

test('AES-128-ECB PKCS7 encrypt matches prepareWeixinUpload cipher size', () => {
    const plaintext = Buffer.alloc(30, 3)
    const plan = prepareWeixinUpload(plaintext)
    assert.equal(plan.cipherSize, aesEcbPaddedSize(30))
    assert.equal(plan.ciphertext.length, plan.cipherSize)
    // Sanity: re-encrypting with the same key reproduces the ciphertext.
    const key = Buffer.from(plan.aesKeyHex, 'hex')
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const expected = Buffer.concat([cipher.update(plaintext), cipher.final()])
    assert.deepEqual(plan.ciphertext, expected)
})
