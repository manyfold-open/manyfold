import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatRepository } from '../src/modules/chat/chat.repository'

const NUL = String.fromCharCode(0)
const LONE_SURROGATE = String.fromCharCode(0xd800)
const REPLACEMENT = String.fromCharCode(0xfffd)

const containsNul = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(NUL)
    if (Array.isArray(value)) return value.some(containsNul)
    if (value !== null && typeof value === 'object')
        return Object.entries(value).some(
            ([key, item]) => key.includes(NUL) || containsNul(item)
        )
    return false
}

const makeDb = (
    existingMessages: Array<Record<string, unknown>> = []
): {
    db: unknown
    insertedRows: Array<Record<string, unknown>>
    updatedSets: Array<Record<string, unknown>>
} => {
    const insertedRows: Array<Record<string, unknown>> = []
    const updatedSets: Array<Record<string, unknown>> = []
    const rejectNul = (value: unknown): void => {
        if (containsNul(value))
            throw new Error('unsupported Unicode escape sequence')
    }
    const db = {
        insert: () => ({
            values: (rows: unknown) => {
                rejectNul(rows)
                const list = (Array.isArray(rows) ? rows : [rows]) as Array<
                    Record<string, unknown>
                >
                insertedRows.push(...list)
                return {
                    returning: async () => list,
                    then: (resolve: (value: unknown) => void) =>
                        resolve(undefined)
                }
            }
        }),
        update: () => ({
            set: (values: Record<string, unknown>) => {
                rejectNul(values)
                updatedSets.push(values)
                return {
                    where: () => ({
                        returning: async () => [values],
                        then: (resolve: (value: unknown) => void) =>
                            resolve(undefined)
                    })
                }
            }
        }),
        delete: () => ({ where: async () => undefined }),
        select: (fields?: Record<string, unknown>) => {
            const selected = fields?.inflightMessageId
                ? [{ inflightMessageId: null }]
                : existingMessages
            return {
                from: () => ({
                    where: () => ({
                        limit: () => ({ for: async () => selected }),
                        orderBy: () => ({
                            for: async () => selected,
                            then: (resolve: (value: unknown) => void) =>
                                resolve(selected)
                        }),
                        then: (resolve: (value: unknown) => void) =>
                            resolve(selected)
                    })
                })
            }
        },
        transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db)
    }
    return { db, insertedRows, updatedSets }
}

test('insertMessage sanitizes contentBlocksJson and capabilityEventsJson', async () => {
    const { db, insertedRows } = makeDb()
    const repo = new ChatRepository(db as never)

    const created = await repo.insertMessage({
        id: 'msg-1',
        sessionId: 'session-1',
        role: 'user',
        contentBlocksJson: [
            { type: 'text', text: `a${NUL}b` },
            { type: 'text', text: `lo${LONE_SURROGATE}ne` }
        ],
        capabilityEventsJson: { model: `m${NUL}1` },
        createdAt: new Date()
    })

    assert.deepEqual(insertedRows[0]?.contentBlocksJson, [
        { type: 'text', text: 'ab' },
        { type: 'text', text: `lo${REPLACEMENT}ne` }
    ])
    assert.deepEqual(insertedRows[0]?.capabilityEventsJson, { model: 'm1' })
    assert.equal(containsNul(created), false)
})

test('appendSessionMessages sanitizes recovered message rows', async () => {
    const { db, insertedRows } = makeDb()
    const repo = new ChatRepository(db as never)

    const result = await repo.appendSessionMessages('session-1', [
        {
            id: 'msg-1',
            sessionId: 'session-1',
            role: 'assistant',
            contentBlocksJson: [
                {
                    type: 'tool_result',
                    toolCallId: 'tool-1',
                    result: { output: `a${NUL}b` }
                }
            ],
            capabilityEventsJson: {
                recoveredFrom: { externalId: `event${NUL}1` }
            },
            createdAt: new Date()
        }
    ])

    assert.equal(result.inserted, 1)
    const blocks = insertedRows[0]?.contentBlocksJson as Array<
        Record<string, unknown>
    >
    assert.deepEqual(blocks[0].result, { output: 'ab' })
    assert.deepEqual(insertedRows[0]?.capabilityEventsJson, {
        recoveredFrom: { externalId: 'event1' }
    })
})

test('replaceSessionMessages sanitizes rebuilt message rows', async () => {
    const { db, insertedRows } = makeDb()
    const repo = new ChatRepository(db as never)

    const result = await repo.replaceSessionMessages(
        'session-1',
        [
            {
                id: 'msg-1',
                sessionId: 'session-1',
                role: 'user',
                contentBlocksJson: [{ type: 'text', text: `hi${NUL}` }],
                capabilityEventsJson: null,
                createdAt: new Date()
            }
        ],
        'ref-1'
    )

    assert.equal(result.replaced, 1)
    assert.deepEqual(insertedRows[0]?.contentBlocksJson, [
        { type: 'text', text: 'hi' }
    ])
    assert.equal(insertedRows[0]?.capabilityEventsJson, null)
})

test('rewriteMessageAndDeleteAfter sanitizes the rewritten blocks', async () => {
    const { db, updatedSets } = makeDb([{ id: 'msg-1' }, { id: 'msg-2' }])
    const repo = new ChatRepository(db as never)

    const result = await repo.rewriteMessageAndDeleteAfter(
        'session-1',
        'msg-1',
        [{ type: 'text', text: `edited${NUL}text` }]
    )

    assert.ok(result)
    assert.deepEqual(result.deletedMessageIds, ['msg-2'])
    assert.deepEqual(updatedSets[0]?.contentBlocksJson, [
        { type: 'text', text: 'editedtext' }
    ])
})
