import {
    DAEMON_FS_WRITE_MAX_BYTES,
    FILES_UPLOAD_MAX_BYTES
} from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PayloadTooLargeException } from '@nestjs/common'
import type { Agent, FileRoot } from '@manyfold/db'
import {
    assertUploadWithinLimit,
    rootCapabilities
} from '../src/modules/agents/files/files-capabilities'

const agent = (overrides: Partial<Agent> = {}): Agent =>
    ({
        id: 'agent-1',
        framework: 'claude-code',
        runtime: 'sprites',
        ...overrides
    }) as Agent

const root = (overrides: Partial<FileRoot> = {}): FileRoot =>
    ({
        id: 'workspace',
        label: 'Workspace',
        path: '/w',
        writable: true,
        ...overrides
    }) as FileRoot

const caps = (a: Agent, r: FileRoot = root(), binaryWriteSafe = true) =>
    rootCapabilities({ agent: a, root: r, binaryWriteSafe })

// clients had no way to learn the real limit before transferring: the API
// accepted 200 MiB and the transport failed afterwards
test('pod-exec advertises its hard 5 MiB / 50 MiB caps', () => {
    const c = caps(agent({ runtime: 'k8s' }), root({ transport: 'pod-exec' }))
    assert.equal(c.maxUploadBytes, 5 * 1024 * 1024)
    assert.equal(c.maxDownloadBytes, 50 * 1024 * 1024)
    assert.equal(c.streamRead, false)
    assert.equal(c.streamWrite, false)
})

// a daemon upload rides one WebSocket frame as base64, so the frame limit —
// not the API's octet-stream parser limit — is what actually bounds it
test('daemon advertises the base64 frame budget as its upload cap', () => {
    const c = caps(agent({ runtime: 'daemon', daemonId: 'dh-1' }))
    assert.equal(c.maxUploadBytes, DAEMON_FS_WRITE_MAX_BYTES)
    assert.ok(c.maxUploadBytes && c.maxUploadBytes < 10 * 1024 * 1024)
    // downloads arrive as 64 KiB chunks, so no frame-driven cap applies
    assert.equal(c.maxDownloadBytes, undefined)
    assert.equal(c.streamRead, true)
})

// binarySafe is a property of the host's CLI version, not of the runtime, so it
// has to be resolved per request
test('daemon binarySafe follows the host feature flag', () => {
    const online = agent({ runtime: 'daemon', daemonId: 'dh-1' })
    assert.equal(caps(online, root(), true).binarySafe, true)
    assert.equal(caps(online, root(), false).binarySafe, false)
})

// no transport-specific cap, but the global ceiling still bounds a request body
test('sprites reports the global ceiling and a streaming atomic write', () => {
    const c = caps(agent())
    assert.equal(c.maxUploadBytes, FILES_UPLOAD_MAX_BYTES)
    assert.equal(c.maxDownloadBytes, undefined)
    assert.equal(c.streamWrite, true)
    assert.equal(c.atomicWrite, true)
})

// both stream the body through and rename into place
test('managed k8s reports a streaming atomic write', () => {
    const c = caps(agent({ runtime: 'k8s' }))
    assert.equal(c.streamWrite, true)
    assert.equal(c.atomicWrite, true)
})

test('narranexus roots report uploads as impossible', () => {
    const c = caps(
        agent({ framework: 'narranexus' }),
        root({ writable: false })
    )
    assert.equal(c.maxUploadBytes, 0)
    assert.equal(c.maxDownloadBytes, 64 * 1024 * 1024)
})

test('assertUploadWithinLimit enforces the global ceiling on capless transports', () => {
    assert.doesNotThrow(() =>
        assertUploadWithinLimit(caps(agent()), FILES_UPLOAD_MAX_BYTES, {
            rootId: 'workspace',
            transport: 'sprites'
        })
    )
    assert.throws(
        () =>
            assertUploadWithinLimit(caps(agent()), FILES_UPLOAD_MAX_BYTES + 1, {
                rootId: 'workspace',
                transport: 'sprites'
            }),
        (err: unknown) => err instanceof PayloadTooLargeException
    )
})

test('assertUploadWithinLimit names the limit it rejected against', () => {
    const c = caps(agent({ runtime: 'k8s' }), root({ transport: 'pod-exec' }))
    assert.throws(
        () =>
            assertUploadWithinLimit(c, 6 * 1024 * 1024, {
                rootId: 'workspace',
                transport: 'pod-exec'
            }),
        (err: unknown) =>
            err instanceof PayloadTooLargeException &&
            err.message.includes('5242880') &&
            err.message.includes('pod-exec')
    )
})

// a read-only root must not accept a zero-byte upload either
test('assertUploadWithinLimit rejects any upload to a read-only root', () => {
    const c = caps(
        agent({ framework: 'narranexus' }),
        root({ writable: false })
    )
    assert.throws(
        () =>
            assertUploadWithinLimit(c, 1, {
                rootId: 'workspace',
                transport: 'narranexus'
            }),
        (err: unknown) => err instanceof PayloadTooLargeException
    )
})
