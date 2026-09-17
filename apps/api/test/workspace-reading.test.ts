import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceReading } from '../src/modules/agents/sprite-storage/workspace-reading'

const measuredAt = new Date('2026-08-01T12:00:00Z')
const breakdown = (workspaceBytes: number) => ({
    workspaceBytes,
    homeBytes: 10,
    totalBytes: 999999,
    measuredVia: 'df' as const
})

test('legacy whole-VM scalar is not treated as workspace evidence', () => {
    const row = {
        storageBytes: 999999,
        storageBreakdown: null,
        storageMeasuredAt: measuredAt
    }
    assert.deepEqual(workspaceReading(row), {
        workspaceBytes: null,
        workspaceMeasuredAt: null
    })
})

test('legacy positive du breakdown keeps its own value and matching time', () => {
    assert.deepEqual(
        workspaceReading({
            storageBreakdown: breakdown(42),
            storageMeasuredAt: measuredAt
        }),
        { workspaceBytes: 42, workspaceMeasuredAt: measuredAt.toISOString() }
    )
})

test('legacy zero, missing time, stale and invalid numeric values stay unknown', () => {
    for (const storageBreakdown of [
        breakdown(0),
        breakdown(-1),
        breakdown(Infinity),
        { ...breakdown(42), measuredVia: 'stale' as const }
    ])
        assert.deepEqual(
            workspaceReading({
                storageBreakdown,
                storageMeasuredAt: measuredAt
            }),
            { workspaceBytes: null, workspaceMeasuredAt: null }
        )
    assert.deepEqual(
        workspaceReading({
            storageBreakdown: breakdown(42),
            storageMeasuredAt: null
        }),
        { workspaceBytes: null, workspaceMeasuredAt: null }
    )
})

test('a newly confirmed zero is a real measurement with its timestamp', () => {
    assert.deepEqual(
        workspaceReading({
            storageBreakdown: { ...breakdown(0), formatVersion: 1 },
            storageMeasuredAt: measuredAt
        }),
        { workspaceBytes: 0, workspaceMeasuredAt: measuredAt.toISOString() }
    )
})
