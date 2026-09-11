import assert from 'node:assert/strict'
import test from 'node:test'
import { wakeRefusalEndsWait, wakeRefusalKind } from '../src/lib/wakeRefusal'

// WHY: a sandbox whose wake the plan refuses must not leave the create form
// spinning. Used-up hours end the wait with a plan pointer; a full slot is
// waited out, since another sandbox falling asleep clears it.
test('used-up active hours and unknown refusals end the wait; a full slot does not', () => {
    assert.equal(wakeRefusalKind('ACTIVE_HOURS_QUOTA_REACHED'), 'hours')
    assert.equal(wakeRefusalKind('CONCURRENT_ACTIVE_LIMIT_REACHED'), 'slot')
    assert.equal(wakeRefusalKind('SANDBOX_NOT_FOUND'), 'other')
    assert.equal(wakeRefusalEndsWait('ACTIVE_HOURS_QUOTA_REACHED'), true)
    assert.equal(wakeRefusalEndsWait('CONCURRENT_ACTIVE_LIMIT_REACHED'), false)
    assert.equal(wakeRefusalEndsWait('WAKE_REFUSED'), true)
})
