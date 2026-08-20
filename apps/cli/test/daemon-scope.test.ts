import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultScope, resolveScope } from '../src/daemon/init-unit'

const withUid = <T>(uid: number | undefined, fn: () => T): T => {
    const original = process.getuid
    process.getuid = uid === undefined ? undefined : () => uid
    try {
        return fn()
    } finally {
        process.getuid = original
    }
}

test('defaultScope picks system scope for root so a fresh EC2 register avoids the missing user systemd session', () => {
    assert.equal(
        withUid(0, () => defaultScope()),
        'system'
    )
})

test('defaultScope keeps user scope for a normal login user', () => {
    assert.equal(
        withUid(1000, () => defaultScope()),
        'user'
    )
})

test('defaultScope falls back to user scope when getuid is unavailable (e.g. Windows)', () => {
    assert.equal(
        withUid(undefined, () => defaultScope()),
        'user'
    )
})

test('resolveScope honours an explicit --system flag even for a non-root user', () => {
    assert.equal(
        withUid(1000, () => resolveScope({ system: true })),
        'system'
    )
})

test('resolveScope honours an explicit --user flag even for root', () => {
    assert.equal(
        withUid(0, () => resolveScope({ user: true })),
        'user'
    )
})

test('resolveScope without flags follows the machine default', () => {
    assert.equal(
        withUid(0, () => resolveScope({})),
        'system'
    )
    assert.equal(
        withUid(1000, () => resolveScope({})),
        'user'
    )
})

test('resolveScope prefers --system when both flags are set', () => {
    assert.equal(
        withUid(1000, () => resolveScope({ system: true, user: true })),
        'system'
    )
})
