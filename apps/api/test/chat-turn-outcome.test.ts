import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatService } from '../src/modules/chat/chat.service'

// getTurnOutcome makes two reads; the turn's terminal transaction (terminal
// row + final message content, insertStreamEvent) can commit between them.
// The repo below commits it right after whichever read runs first.
// Seen on prod [2026-10-15..17]: read message-first, that pairing gave
// `done` with the pre-terminal content (empty), and A2A reconcile stored it as
// the task's artifact while the message held the reply.
const racingService = () => {
    let committed = false
    const reads: string[] = []
    const afterRead = () => {
        committed = true
    }
    const service = Object.create(ChatService.prototype) as ChatService
    Object.assign(service, {
        repo: {
            getMessageById: async (id: string) => {
                reads.push('message')
                const contentBlocksJson = committed
                    ? [{ type: 'text', text: 'The Tower, upright.' }]
                    : []
                afterRead()
                return { id, contentBlocksJson }
            },
            findTerminalStreamEvent: async () => {
                reads.push('terminal')
                const terminal = committed
                    ? { eventType: 'done', payloadJson: {} }
                    : null
                afterRead()
                return terminal
            }
        }
    })
    return { service, reads }
}

test('a terminal that commits between the reads never yields done with stale content', async () => {
    const { service, reads } = racingService()

    const first = await service.getTurnOutcome('m1')

    assert.deepEqual(reads, ['terminal', 'message'])
    assert.deepEqual(first, { state: 'running' })
    assert.deepEqual(await service.getTurnOutcome('m1'), {
        state: 'done',
        text: 'The Tower, upright.'
    })
})

test('a message that does not exist is missing, terminal or not', async () => {
    const service = Object.create(ChatService.prototype) as ChatService
    Object.assign(service, {
        repo: {
            getMessageById: async () => null,
            findTerminalStreamEvent: async () => null
        }
    })
    assert.deepEqual(await service.getTurnOutcome('gone'), { state: 'missing' })
})
