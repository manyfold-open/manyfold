import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveImageContentType } from '../src/modules/agents/files/files-content-type'

test('infers common image MIME types when a transport reports octet-stream', () => {
    assert.equal(
        resolveImageContentType(
            '/workspace/logo.PNG',
            'application/octet-stream'
        ),
        'image/png'
    )
    assert.equal(
        resolveImageContentType(
            '/workspace/photo.JPEG',
            'application/octet-stream; charset=binary'
        ),
        'image/jpeg'
    )
    assert.equal(
        resolveImageContentType('/workspace/preview.webp', ''),
        'image/webp'
    )
})

test('keeps explicit transport MIME types authoritative', () => {
    assert.equal(
        resolveImageContentType('/workspace/misleading.png', 'image/jpeg'),
        'image/jpeg'
    )
    assert.equal(
        resolveImageContentType('/workspace/misleading.png', 'text/plain'),
        'text/plain'
    )
})

test('does not infer non-image or unknown content types', () => {
    assert.equal(
        resolveImageContentType(
            '/workspace/report.pdf',
            'application/octet-stream'
        ),
        'application/octet-stream'
    )
    assert.equal(
        resolveImageContentType('/workspace/blob.bin', null),
        'application/octet-stream'
    )
})
