import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { turnStartFailureCode } from '../src/modules/a2a/a2a.service'
import {
    InflightTurnConflictError,
    SessionHeldByTerminalError,
    SessionImportPendingError
} from '../src/modules/chat/chat.service'

// A task that fails before its turn starts names why in a stable code; the
// two session-ownership refusals of ADR-0029 mirror the HTTP 409 body codes
// and are distinct from the inflight turn a caller may wait out.
test('a2a task failure codes for a refused turn', () => {
    assert.equal(
        turnStartFailureCode(new InflightTurnConflictError()),
        'inflight_turn'
    )
    assert.equal(
        turnStartFailureCode(new SessionHeldByTerminalError()),
        'session_held_by_terminal'
    )
    assert.equal(
        turnStartFailureCode(new SessionImportPendingError()),
        'session_import_pending'
    )
    assert.equal(
        turnStartFailureCode(new BadRequestException('nope')),
        'turn_start_failed'
    )
})
