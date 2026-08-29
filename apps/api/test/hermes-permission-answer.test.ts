import assert from 'node:assert/strict'
import test from 'node:test'
import { BadGatewayException, ConflictException } from '@nestjs/common'
import { ChatService } from '../src/modules/chat/chat.service'

// The routing matrix for a hermes permission answer: local coordinator first,
// then the daemon that carries the turn (turn.permission RPC), then the
// durable row + NOTIFY for a peer-owned interactive turn — cancel's contract.
const buildService = (opts: {
    message: Record<string, unknown> | null
    terminal?: boolean
    coordinator?: {
        respondLocal: (
            m: string,
            r: string,
            o: string
        ) => 'delivered' | 'unknown' | 'no_holder'
    }
    daemonRpc?: (args: {
        daemonId: string
        method: string
        payload: Record<string, unknown>
    }) => Promise<Record<string, unknown> | undefined>
}) => {
    const inserted: Array<Record<string, unknown>> = []
    const notified: Array<[string, string, string]> = []
    const rpcCalls: Array<Record<string, unknown>> = []
    const repo = {
        getSession: async () => ({
            id: 'cts_1',
            userId: 'user-1',
            agentId: 'agt_1'
        }),
        getMessageById: async () => opts.message,
        findTerminalStreamEvent: async () =>
            opts.terminal ? { type: 'done' } : null,
        insertPermissionAnswer: async (row: Record<string, unknown>) => {
            const dup = inserted.some(
                (r) =>
                    r.messageId === row.messageId &&
                    r.requestId === row.requestId
            )
            if (dup) return false
            inserted.push(row)
            return true
        }
    }
    const service = new ChatService(
        {} as never,
        repo as never,
        {} as never,
        { get: () => ({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        { event: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        (opts.coordinator ?? undefined) as never,
        {
            notify: (m: string, r: string, o: string) =>
                notified.push([m, r, o])
        } as never,
        (opts.daemonRpc
            ? {
                  rpc: async (args: {
                      daemonId: string
                      method: string
                      payload: Record<string, unknown>
                  }) => {
                      rpcCalls.push(args as unknown as Record<string, unknown>)
                      return opts.daemonRpc!(args)
                  }
              }
            : undefined) as never
    )
    return { service, inserted, notified, rpcCalls }
}

const interactiveMessage = {
    id: 'msg_1',
    sessionId: 'cts_1',
    daemonId: null,
    daemonExecRef: null
}
const daemonMessage = {
    id: 'msg_1',
    sessionId: 'cts_1',
    daemonId: 'dh_1',
    daemonExecRef: 'msg_1'
}

test('a local holder gets the answer and the audit row lands', async () => {
    const seen: Array<[string, string, string]> = []
    const h = buildService({
        message: interactiveMessage,
        coordinator: {
            respondLocal: (m, r, o) => {
                seen.push([m, r, o])
                return 'delivered'
            }
        }
    })
    await h.service.answerPermission(
        'user-1',
        'agt_1',
        'cts_1',
        'msg_1',
        'req-1',
        'allow_once'
    )
    assert.deepEqual(seen, [['msg_1', 'req-1', 'allow_once']])
    assert.equal(h.inserted.length, 1)
    assert.equal(h.notified.length, 0, 'a delivered answer needs no broadcast')
})

test('a holder that no longer knows the request is a 409', async () => {
    const h = buildService({
        message: interactiveMessage,
        coordinator: { respondLocal: () => 'unknown' }
    })
    await assert.rejects(
        h.service.answerPermission(
            'user-1',
            'agt_1',
            'cts_1',
            'msg_1',
            'req-1',
            'allow_once'
        ),
        ConflictException
    )
})

test('a daemon-carried turn routes over turn.permission with the exec ref', async () => {
    const h = buildService({
        message: daemonMessage,
        coordinator: { respondLocal: () => 'no_holder' },
        daemonRpc: async () => ({ ok: true })
    })
    await h.service.answerPermission(
        'user-1',
        'agt_1',
        'cts_1',
        'msg_1',
        'req-2',
        'deny'
    )
    assert.equal(h.rpcCalls.length, 1)
    assert.equal(h.rpcCalls[0].method, 'turn.permission')
    assert.deepEqual(h.rpcCalls[0].payload, {
        refId: 'msg_1',
        requestId: 'req-2',
        optionId: 'deny'
    })
})

test('a daemon that reports unknown_request is a 409; a dead transport is a 502', async () => {
    const conflict = buildService({
        message: daemonMessage,
        daemonRpc: async () => ({ ok: false, error: 'unknown_request' })
    })
    await assert.rejects(
        conflict.service.answerPermission(
            'user-1',
            'agt_1',
            'cts_1',
            'msg_1',
            'req-3',
            'deny'
        ),
        ConflictException
    )
    const gateway = buildService({
        message: daemonMessage,
        daemonRpc: async () => {
            throw new Error('daemon offline')
        }
    })
    await assert.rejects(
        gateway.service.answerPermission(
            'user-1',
            'agt_1',
            'cts_1',
            'msg_1',
            'req-3',
            'deny'
        ),
        BadGatewayException
    )
})

test('a peer-owned interactive turn gets the durable row plus the broadcast, once', async () => {
    const h = buildService({
        message: interactiveMessage,
        coordinator: { respondLocal: () => 'no_holder' }
    })
    await h.service.answerPermission(
        'user-1',
        'agt_1',
        'cts_1',
        'msg_1',
        'req-4',
        'allow_once'
    )
    assert.deepEqual(h.notified, [['msg_1', 'req-4', 'allow_once']])
    // the second click races the first and loses on the PK
    await assert.rejects(
        h.service.answerPermission(
            'user-1',
            'agt_1',
            'cts_1',
            'msg_1',
            'req-4',
            'deny'
        ),
        ConflictException
    )
})

test('a turn that already ended refuses every answer', async () => {
    const h = buildService({ message: interactiveMessage, terminal: true })
    await assert.rejects(
        h.service.answerPermission(
            'user-1',
            'agt_1',
            'cts_1',
            'msg_1',
            'req-5',
            'allow_once'
        ),
        ConflictException
    )
})
