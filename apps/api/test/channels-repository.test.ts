import assert from 'node:assert/strict'
import test from 'node:test'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'

test('ChannelsRepository reads and upserts provider state', async () => {
    const db = new FakeDb()
    const repo = new ChannelsRepository(db as never)

    db.selected = [
        {
            channelId: 'chn-1',
            stateJson: { nextBatch: 's1' },
            createdAt: new Date(),
            updatedAt: new Date()
        }
    ]
    const state = await repo.getProviderState('chn-1')
    assert.equal(state?.channelId, 'chn-1')
    assert.deepEqual(state?.stateJson, { nextBatch: 's1' })

    const upserted = await repo.upsertProviderState({
        channelId: 'chn-1',
        stateJson: { nextBatch: 's2' },
        createdAt: new Date(),
        updatedAt: new Date()
    })
    assert.equal(upserted.channelId, 'chn-1')
    assert.deepEqual(upserted.stateJson, { nextBatch: 's2' })
    assert.deepEqual(db.lastConflictSet?.stateJson, { nextBatch: 's2' })
    assert.ok(db.lastConflictSet?.updatedAt instanceof Date)
})

class FakeDb {
    selected: unknown[] = []
    lastConflictSet: Record<string, unknown> | null = null

    select(): {
        from: () => {
            where: () => {
                limit: () => Promise<unknown[]>
            }
        }
    } {
        return {
            from: () => ({
                where: () => ({
                    limit: async () => this.selected
                })
            })
        }
    }

    insert(): {
        values: (row: Record<string, unknown>) => {
            onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
                returning: () => Promise<unknown[]>
            }
        }
    } {
        return {
            values: (row) => ({
                onConflictDoUpdate: (arg) => {
                    this.lastConflictSet = arg.set
                    return {
                        returning: async () => [
                            {
                                ...row,
                                updatedAt: arg.set.updatedAt
                            }
                        ]
                    }
                }
            })
        }
    }
}
