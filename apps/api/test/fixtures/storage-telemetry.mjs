import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require('tsconfig-paths/register')
const { otel, flushOtelLogs, flushSentrySpans } = require('../../src/otel.ts')
const { trace } = require('@opentelemetry/api')
const { flushSentry, setSentryRequestContext } = require('../../src/sentry.ts')
const {
    TelemetryService
} = require('../../src/common/telemetry/telemetry.service.ts')
const {
    HostStorageService
} = require('../../src/modules/agents/host-storage/host-storage.service.ts')
const { fixtureHostAccess } = require('../helpers/fixture-daemon-exec.ts')
const { createDb, runtimeHosts } = require('@manyfold/db')
const { eq, sql } = require('drizzle-orm')

const db = createDb(process.env.PG_FIXTURE_URL)
try {
    const service = new HostStorageService(
        db,
        fixtureHostAccess(process.env.SPRITE_FIXTURE_ORIGIN.replace('http:', 'ws:')),
        new TelemetryService()
    )
    if (process.env.STORAGE_FIXTURE_MODE === 'short_lease') {
        // The lease left once the attempt is claimed is what bounds the exec.
        const targetFor = service.targetFor.bind(service)
        const measure = service.measureNow.bind(service)
        Object.assign(service, {
            targetFor: async (...args) => {
                const target = await targetFor(...args)
                await db
                    .update(runtimeHosts)
                    .set({
                        storageLeaseUntil: sql`clock_timestamp() + interval '500 milliseconds'`
                    })
                    .where(eq(runtimeHosts.id, process.env.STORAGE_FIXTURE_HOST))
                return target
            },
            measureNow: async (...args) => {
                try {
                    return await measure(...args)
                } catch (error) {
                    const actual = /^exec timed out after (\d+)ms$/.exec(
                        error?.message ?? ''
                    )
                    if (actual) console.log(`fixture exec timeout ${actual[1]}`)
                    throw error
                }
            }
        })
    }
    await trace
        .getTracer('fixture')
        .startActiveSpan('foreground.fixture', async (span) => {
            try {
                setSentryRequestContext('private-storage-request-user', {
                    owner: 'private-storage-request-user'
                })
                await fetch(
                    process.env.SPRITE_FIXTURE_ORIGIN +
                        '/ordinary-storage-control'
                )
                await service.measureHostIfDue(
                    process.env.STORAGE_FIXTURE_HOST,
                    'chat'
                )
            } finally {
                span.end()
            }
        })
} finally {
    await db.$client.end()
    await flushSentrySpans()
    await flushSentry(2000)
    await flushOtelLogs()
    await otel.shutdown()
}
