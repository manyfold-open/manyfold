import { FILES_UPLOAD_MAX_BYTES } from '@manyfold/shared'
import test from 'node:test'
import { FIXTURE } from './helpers/fixture-framework'
import assert from 'node:assert/strict'
import { PayloadTooLargeException } from '@nestjs/common'
import type { FileRoot } from '@manyfold/db'
import {
    assertUploadWithinLimit,
    rootCapabilities
} from '../src/modules/agents/files/files-capabilities'

const root = (overrides: Partial<FileRoot> = {}): FileRoot =>
    ({
        id: 'workspace',
        label: 'Workspace',
        path: '/w',
        writable: true,
        ...overrides
    }) as FileRoot

const caps = (framework = 'claude-code', r: FileRoot = root()) =>
    rootCapabilities({ framework, root: r })

// Every machine's files go through its daemon, which streams both ways and
// renames a finished part over the target: the global ceiling is the only
// cap, a sandbox, a cloud computer and a self-owned computer alike.
test('a daemon root streams both ways under the global ceiling, atomically', () => {
    const c = caps()
    assert.equal(c.maxUploadBytes, FILES_UPLOAD_MAX_BYTES)
    assert.equal(c.maxDownloadBytes, undefined)
    assert.equal(c.streamRead, true)
    assert.equal(c.streamWrite, true)
    assert.equal(c.binarySafe, true)
    assert.equal(c.atomicWrite, true)
})

test('framework-served roots report uploads as impossible', () => {
    const c = caps(FIXTURE, root({ writable: false }))
    assert.equal(c.maxUploadBytes, 0)
    assert.equal(c.maxDownloadBytes, 8 * 1024 * 1024)
})

test('assertUploadWithinLimit enforces the global ceiling and names it', () => {
    assert.doesNotThrow(() =>
        assertUploadWithinLimit(caps(), FILES_UPLOAD_MAX_BYTES, {
            rootId: 'workspace',
            transport: 'sprites'
        })
    )
    assert.throws(
        () =>
            assertUploadWithinLimit(caps(), FILES_UPLOAD_MAX_BYTES + 1, {
                rootId: 'workspace',
                transport: 'sprites'
            }),
        (err: unknown) =>
            err instanceof PayloadTooLargeException &&
            err.message.includes(String(FILES_UPLOAD_MAX_BYTES)) &&
            err.message.includes('sprites')
    )
})

// a read-only root must not accept a zero-byte upload either
test('assertUploadWithinLimit rejects any upload to a read-only root', () => {
    const c = caps(FIXTURE, root({ writable: false }))
    assert.throws(
        () =>
            assertUploadWithinLimit(c, 1, {
                rootId: 'workspace',
                transport: FIXTURE
            }),
        (err: unknown) => err instanceof PayloadTooLargeException
    )
})
