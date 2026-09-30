import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { InternalServerErrorException } from '@nestjs/common'
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
// Its commands run through the host's daemon, and its services are the
// daemon's.

const owned = (framework: string) =>
    runtimeRow({ id: 'art_1', framework: framework as never, hostId: 'sbx_1' })

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

const build = (opts: {
    framework: string
    events: string[]
    catalog: { versions: string[]; sourceRepo: string | null }
    installed: string
    // The exit codes the machine's commands answer with, in order (0 once
    // they run out).
    exitCodes?: number[]
}) => {
    const exitCodes = [...(opts.exitCodes ?? [])]
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
                    events.push('exec')
                    return { exitCode: exitCodes.shift() ?? 0, stdout: '', stderr: 'boom' }
                }
            })
        } as never,
        {
            serviceHost: () => ({ home: '/home/sprite', suspends: true }),
            list: async () => [{ name: opts.framework, state: 'running' }],
            restart: async (_host: unknown, name: string) => {
                events.push(`restart:${name}`)
            },
            stop: async (_host: unknown, name: string) => {
                events.push(`stop:${name}`)
            },
            start: async (_host: unknown, name: string) => {
                events.push(`start:${name}`)
            },
            waitHealthy: async () => {},
            markReady: async () => {}
        } as never,
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
        installed: '2026.9.6'
    })
    await service.upgrade(owned('openclaw'), '2026.9.6', false)
    assert.deepEqual(events, [
        'hold',
        'exec',
        'restart:openclaw',
        'verify',
        'release'
    ])
})

const hermes = {
    versions: ['v2026.9.24'],
    sourceRepo: 'NousResearch/hermes-agent'
}

test('a rebuild holds the sandbox from stopping the service to verifying the new version', async () => {
    const events: string[] = []
    const service = build({
        framework: 'hermes',
        events,
        catalog: hermes,
        installed: '2026.9.24'
    })
    await service.upgradeStreaming(owned('hermes'), 'v2026.9.24', false, {
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

test('a failed rebuild restores and restarts the old checkout before letting the sandbox go', async () => {
    const events: string[] = []
    const service = build({
        framework: 'hermes',
        events,
        catalog: hermes,
        installed: '2026.9.24',
        exitCodes: [1]
    })
    await assert.rejects(
        service.upgradeStreaming(owned('hermes'), 'v2026.9.24', false, {
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
