import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import { createDb } from '@manyfold/db'
import { withRuntimeUpgradeLock } from '../src/common/runtime-upgrade-lock'
import { FrameworkUpgradeService } from '../src/modules/agents/framework-versions/framework-upgrade.service'

test(
    'upgrade locks exclude another API connection, scope by installation, and release on failure',
    {
        skip: process.env.RUN_PG_E2E !== '1' && 'set RUN_PG_E2E=1 to run'
    },
    async (t) => {
        const url = process.env.DATABASE_URL
        assert.ok(url)
        const first = createDb(url, { max: 1 })
        const second = createDb(url, { max: 1 })
        t.after(async () => {
            await first.$client.end()
            await second.$client.end()
        })
        const target = {
            accountId: randomUUID(),
            spriteName: 'same-sprite',
            component: 'codex'
        }
        let release!: () => void
        let entered!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const started = new Promise<void>((resolve) => {
            entered = resolve
        })
        const held = withRuntimeUpgradeLock(first, target, async () => {
            entered()
            await gate
            throw new Error('install failed')
        })
        const failed = assert.rejects(held, /install failed/)
        await started
        try {
            await assert.rejects(
                withRuntimeUpgradeLock(second, target, async () => {
                    assert.fail('duplicate install must never execute')
                }),
                (err: unknown) =>
                    err instanceof ConflictException && err.getStatus() === 409
            )
            for (const other of [
                { ...target, accountId: randomUUID() },
                { ...target, spriteName: 'other-sprite' },
                { ...target, component: 'mf-cli' }
            ])
                assert.equal(
                    await withRuntimeUpgradeLock(
                        second,
                        other,
                        async () => 'independent'
                    ),
                    'independent'
                )
        } finally {
            release()
            await failed
        }
        assert.equal(
            await withRuntimeUpgradeLock(second, target, async () => 'retry'),
            'retry'
        )
        assert.equal(
            await withRuntimeUpgradeLock(
                first,
                target,
                async () => 'after-success'
            ),
            'after-success'
        )
    }
)

test(
    'two agents on one framework installation share the same upgrade lock across API instances',
    {
        skip: process.env.RUN_PG_E2E !== '1' && 'set RUN_PG_E2E=1 to run'
    },
    async (t) => {
        const url = process.env.DATABASE_URL
        assert.ok(url)
        const databases = [createDb(url, { max: 1 }), createDb(url, { max: 1 })]
        t.after(async () => {
            await Promise.all(databases.map((db) => db.$client.end()))
        })
        const accountId = randomUUID()
        let release!: () => void
        let entered!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const started = new Promise<void>((resolve) => {
            entered = resolve
        })
        const services = databases.map(
            (db) =>
                new FrameworkUpgradeService(
                    {
                        transaction: db.transaction.bind(db),
                        select: () => ({
                            from: () => ({
                                where: () => ({
                                    limit: async () => [
                                        {
                                            id: 'runtime',
                                            kind: 'sprites',
                                            accountId,
                                            spriteName: 'shared',
                                            frameworkVersion: '0.9.0'
                                        }
                                    ]
                                })
                            })
                        })
                    } as never,
                    {
                        getById: async () => {
                            entered()
                            await gate
                            throw new Error('sprite boundary')
                        }
                    } as never,
                    {
                        findForCaller: async (id: string) => ({
                            id,
                            framework: 'codex',
                            runtimeId: 'runtime',
                            accountId,
                            spriteName: 'shared'
                        })
                    } as never,
                    {
                        getForFramework: async () => ({
                            versions: ['1.0.0'],
                            blocked: []
                        })
                    } as never,
                    {} as never,
                    {
                        getCachedFrameworkDefaultVersions: async () => ({
                            minVersions: {},
                            allowDowngrade: {}
                        })
                    } as never
                )
        )
        const first = assert.rejects(
            services[0].upgrade('agent-a', 'owner', '1.0.0', false),
            /sprite boundary/
        )
        await started
        try {
            await assert.rejects(
                services[1].upgrade('agent-b', 'owner', '1.0.0', false),
                (err: unknown) =>
                    err instanceof ConflictException && err.getStatus() === 409
            )
        } finally {
            release()
            await first
        }
        await assert.rejects(
            services[1].upgrade('agent-b', 'owner', '1.0.0', false),
            /sprite boundary/
        )
    }
)
