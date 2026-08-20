import assert from 'node:assert/strict'
import test from 'node:test'
import {
    spriteStatusDotClass,
    spriteStatusLabel,
    spriteStatusTone
} from '../src/lib/spriteStatus'

// A sandbox host's status must mirror the sprites.dev lifecycle
// (active/warm/cold), not the runtime provisioning status — the bug was every
// host reading "ready"/green regardless of whether the VM was actually warm or
// cold. These assertions lock the three lifecycle states to distinct dots.
test('sprite lifecycle maps to distinct labels', () => {
    assert.equal(spriteStatusLabel('running'), 'Active')
    assert.equal(spriteStatusLabel('warm'), 'Warm')
    assert.equal(spriteStatusLabel('cold'), 'Cold')
})

test('sprite lifecycle maps to distinct dot colours', () => {
    assert.equal(spriteStatusDotClass('running'), 'bg-success')
    assert.equal(spriteStatusDotClass('warm'), 'bg-warning')
    assert.equal(spriteStatusDotClass('cold'), 'bg-idle')
    const dots = new Set([
        spriteStatusDotClass('running'),
        spriteStatusDotClass('warm'),
        spriteStatusDotClass('cold')
    ])
    assert.equal(dots.size, 3)
})

test('a not-yet-reported sprite reads as provisioning, never active', () => {
    assert.equal(spriteStatusLabel(null), 'Provisioning')
    assert.equal(spriteStatusTone(null), 'idle')
    assert.notEqual(spriteStatusDotClass(null), 'bg-success')
})