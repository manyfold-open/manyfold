import assert from 'node:assert/strict'
import { once } from 'node:events'
import test, { type TestContext } from 'node:test'
import 'reflect-metadata'
import { InternalServerErrorException } from '@nestjs/common'
import { WebSocketServer } from 'ws'
import { FrameworkUpgradeService } from '../src/modules/agents/framework-versions/framework-upgrade.service'
import {
    contextOf,
    fakeRuntimeContext,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// A framework upgrade on a sandbox runs under the machine's awake hold from
// its first step to its verification (ADR-0038). The service calls between
// commands are no activity to a sprite, so a machine let go froze under them.

const noPolicy = {
    getCachedFrameworkDefaultVersions: async () => ({
        defaults: {},
        minVersions: {},
        allowDowngrade: {},
        blockedVersions: {},
        sourceRepos: {},
        allowPrerelease: {}
    })
}

// The sprite's exec endpoint: each command is recorded and answers with the
// next exit code (0 once they run out).
const execPeer = async (
    t: TestContext,
    events: string[],
    exitCodes: number[] = []
): Promise<string> => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    t.after(async () => {
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    server.on('connection', (socket) => {
        events.push('exec')
        socket.send(Buffer.from([0x03, exitCodes.shift() ?? 0]))
    })
    return `ws://127.0.0.1:${address.port}`
}

const build = (opts: {
    framework: string
    events: string[]
    catalog: { versions: string[]; sourceRepo: string | null }
    installed: string
    client: Record<string, unknown>
}) => {
    const { events } = opts
    const host = spritesHostRow({ id: 'sbx_1' })
    const runtime = runtimeRow({
        id: 'art_1',
        framework: opts.framework as never,
        hostId: host.id
    })
    const hostAccess = {
        hold: () => {
            events.push('hold')
            return {
                settled: Promise.resolve(true),
                release: async () => {
                    events.push('release')
                },
                detach: () => {}
            }
        }
    }
    return new FrameworkUpgradeService(
        {
            transaction: async (work: (tx: unknown) => Promise<unknown>) =>
                work({ execute: async () => [{ acquired: true }] })
        } as never,
        {
            findForCaller: async () => ({
                id: 'agt_1',
                framework: opts.framework,
                runtimeId: runtime.id
            }),
            get: async () => ({ id: 'agt_1' })
        } as never,
        {
            getForFramework: async () => ({
                ...opts.catalog,
                latest: opts.catalog.versions[0],
                blocked: []
            })
        } as never,
        {
            probeAndPersist: async () => {
                events.push('verify')
                return opts.installed
            }
        } as never,
        noPolicy as never,
        fakeRuntimeContext(contextOf({ runtime, host })) as never,
        {
            forRuntime: async () => ({
                run: async () => {
                    events.push('install')
                    return { exitCode: 0, stdout: '', stderr: '' }
                }
            })
        } as never,
        {
            spritesClientForHost: async () => ({
                client: opts.client,
                spriteName: 'sprite-1',
                provider: {}
            })
        } as never,
        undefined,
        undefined,
        hostAccess as never
    )
}

test('an in-place upgrade holds the sandbox across the install, the service restart and the verification', async () => {
    const events: string[] = []
    const service = build({
        framework: 'openclaw',
        events,
        catalog: { versions: ['2026.9.6'], sourceRepo: null },
        installed: '2026.9.6',
        client: {
            restartService: async () => {
                events.push('restart')
            }
        }
    })
    await service.upgrade('agt_1', 'usr_1', '2026.9.6', false)
    assert.deepEqual(events, [
        'hold',
        'install',
        'restart',
        'verify',
        'release'
    ])
})

const rebuildClient = (wsBaseUrl: string, events: string[]) => ({
    wsBaseUrl,
    authHeaderForInternalUse: () => ({}),
    stopService: async (_sprite: string, name: string) => {
        events.push(`stop:${name}`)
    },
    startService: async (_sprite: string, name: string) => {
        events.push(`start:${name}`)
        return { state: { status: 'running' } }
    }
})

const hermes = {
    versions: ['v2026.9.24'],
    sourceRepo: 'NousResearch/hermes-agent'
}

test('a rebuild holds the sandbox from stopping the service to verifying the new version', async (t) => {
    const events: string[] = []
    const service = build({
        framework: 'hermes',
        events,
        catalog: hermes,
        installed: '2026.9.24',
        client: rebuildClient(await execPeer(t, events), events)
    })
    await service.upgradeStreaming('agt_1', 'usr_1', 'v2026.9.24', false, {
        step: () => {}
    })
    assert.deepEqual(events, [
        'hold',
        'stop:hermes',
        'exec',
        'start:hermes',
        'verify',
        'release'
    ])
})

test('a failed rebuild restores and restarts the old checkout before letting the sandbox go', async (t) => {
    const events: string[] = []
    const service = build({
        framework: 'hermes',
        events,
        catalog: hermes,
        installed: '2026.9.24',
        client: rebuildClient(await execPeer(t, events, [1]), events)
    })
    await assert.rejects(
        service.upgradeStreaming('agt_1', 'usr_1', 'v2026.9.24', false, {
            step: () => {}
        }),
        (err: unknown) =>
            err instanceof InternalServerErrorException &&
            /rebuild failed/.test((err as Error).message)
    )
    assert.deepEqual(events, [
        'hold',
        'stop:hermes',
        'exec',
        'exec',
        'start:hermes',
        'release'
    ])
})
