import { createRequire, syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
const require = createRequire(import.meta.url)
const fs = require('node:fs/promises')
const originalWrite = fs.writeFile
let holdWrite = false
let releaseWrite
let dropReply = false
let malformedRead = false
let readValue
let failWriteSuffix
fs.writeFile = async (...args) => {
    if (
        holdWrite &&
        /\.mcp\.json(?:\.mf-config-[^/]+\.tmp)?$/.test(String(args[0]))
    ) {
        holdWrite = false
        process.send?.({ type: 'write-held' })
        await new Promise((resolve) => {
            releaseWrite = resolve
        })
    }
    return originalWrite(...args)
}
syncBuiltinESMExports()
const { rpcHandler, setDeclaredWorkspaceRoot } =
    await import('../../src/daemon/rpc.ts')
const { WebSocket } = await import('ws')
const { DAEMON_CLIENT_FEATURES, DAEMON_MIN_CLI_VERSION } =
    await import('@manyfold/shared')
setDeclaredWorkspaceRoot(process.env.FIXTURE_WORKSPACE)
const sockets = new Set()
const cancel = new Map()
let socket
const connect = (
    url,
    inventory = true,
    version = DAEMON_MIN_CLI_VERSION,
    features = DAEMON_CLIENT_FEATURES
) => {
    socket = new WebSocket(url, {
        headers: { Authorization: 'Bearer fixture-only' }
    })
    const own = socket
    sockets.add(own)
    own.on('error', () => {})
    own.on('close', (code) => {
        sockets.delete(own)
        process.send?.({ type: 'closed', code })
    })
    own.on('open', () =>
        own.send(
            JSON.stringify({
                type: 'hello',
                daemonUuid: 'owned-config-fixture',
                cliVersion: version,
                clientFeatures: features,
                clientProcess: { instanceId: randomUUID(), pid: process.pid },
                ...(inventory ? { inflightStreams: [] } : {})
            })
        )
    )
    own.on('message', async (bytes) => {
        const frame = JSON.parse(String(bytes))
        if (frame.type === 'welcome') process.send?.({ type: 'welcome' })
        if (frame.type === 'ping') own.send(JSON.stringify({ type: 'pong' }))
        if (frame.type === 'cancel' && cancel.has(frame.refId)) {
            cancel.get(frame.refId)()
            process.send?.({ type: 'cancel-seen' })
        }
        if (frame.type !== 'push') return
        process.send?.({ type: 'rpc', method: frame.method })
        if (frame.method === 'fs.read' && malformedRead) {
            own.send(
                JSON.stringify({
                    type: 'ack',
                    refId: frame.refId,
                    ok: true,
                    payload: { content: readValue }
                })
            )
            return
        }
        if (
            frame.method === 'fs.write' &&
            failWriteSuffix &&
            String(frame.payload.path).endsWith(failWriteSuffix)
        ) {
            failWriteSuffix = undefined
            own.send(
                JSON.stringify({
                    type: 'ack',
                    refId: frame.refId,
                    ok: false,
                    error: 'fixture_io_failure'
                })
            )
            process.send?.({ type: 'write-failed' })
            return
        }
        try {
            const result = await rpcHandler(frame.method, frame.payload, {
                refId: frame.refId,
                isCurrentConnection: () =>
                    socket === own && own.readyState === WebSocket.OPEN,
                sendEvent: (kind, data, seq) => {
                    if (own.readyState === WebSocket.OPEN)
                        own.send(
                            JSON.stringify({
                                type: 'event',
                                refId: frame.refId,
                                kind,
                                data,
                                seq
                            })
                        )
                },
                onCancel: (handler) => cancel.set(frame.refId, handler)
            })
            process.send?.({
                type: 'rpc-complete',
                method: frame.method,
                ok: result.ok
            })
            if (own.readyState === WebSocket.OPEN)
                own.send(
                    JSON.stringify({
                        type: 'ack',
                        refId: frame.refId,
                        ...result
                    })
                )
        } catch (error) {
            if (own.readyState === WebSocket.OPEN)
                own.send(
                    JSON.stringify({
                        type: 'ack',
                        refId: frame.refId,
                        ok: false,
                        error: String(error)
                    })
                )
        } finally {
            cancel.delete(frame.refId)
        }
    })
}
process.on('message', (message) => {
    if (message.type === 'rpc-request') {
        void rpcHandler(message.method, message.payload, {
            refId: message.id,
            sendEvent: () => {},
            isCurrentConnection: () => true,
            onCancel: (handler) => cancel.set(message.id, handler)
        })
            .then((result) => {
                if (dropReply) {
                    dropReply = false
                    process.send?.({ type: 'reply-held', id: message.id })
                } else
                    process.send?.({
                        type: 'rpc-result',
                        id: message.id,
                        result
                    })
            })
            .catch((error) =>
                process.send?.({
                    type: 'rpc-result',
                    id: message.id,
                    result: { ok: false, error: String(error) }
                })
            )
            .finally(() => cancel.delete(message.id))
    }
    if (message.type === 'cancel-request') cancel.get(message.id)?.()
    if (message.type === 'connect')
        connect(
            message.url,
            message.inventory,
            message.version,
            message.features
        )
    if (message.type === 'disconnect') socket?.close()
    if (message.type === 'malformed-read') {
        malformedRead = message.enabled
        readValue = message.value
        process.send?.({ type: 'read-mode-set' })
    }
    if (message.type === 'fail-write') {
        failWriteSuffix = message.suffix
        process.send?.({ type: 'write-failure-set' })
    }
    if (message.type === 'hold-reply') {
        dropReply = true
        process.send?.({ type: 'reply-holding-enabled' })
    }
    if (message.type === 'hello' && socket?.readyState === WebSocket.OPEN)
        socket.send(
            JSON.stringify({
                type: 'hello',
                cliVersion: DAEMON_MIN_CLI_VERSION,
                clientFeatures: DAEMON_CLIENT_FEATURES,
                inflightStreams: []
            })
        )
    if (message.type === 'hold-write') {
        holdWrite = true
        process.send?.({ type: 'holding-enabled' })
    }
    if (message.type === 'release-write') releaseWrite?.()
    if (message.type === 'stop') {
        releaseWrite?.()
        for (const own of sockets) own.terminate()
        for (const handler of cancel.values()) handler()
        process.disconnect()
    }
})
process.send?.({ type: 'ready' })
