import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require('tsconfig-paths/register')
const { otel, flushOtelLogs, flushSentrySpans } = require('../../src/otel.ts')
const { trace } = require('@opentelemetry/api')
const {
    captureApiException,
    flushSentry,
    setSentryRequestContext
} = require('../../src/sentry.ts')
const {
    SkillDiscoveryService
} = require('../../src/modules/skills/skill-discovery.service.ts')
const { SkillsService } = require('../../src/modules/skills/skills.service.ts')
const {
    HttpExceptionFilter
} = require('../../src/common/filters/http-exception.filter.ts')
const { createDb } = require('@manyfold/db')

const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
    const url = new URL(String(input))
    if (
        ['api.github.com', 'raw.githubusercontent.com'].includes(url.hostname)
    ) {
        const host = url.hostname
        const target = new URL(
            url.pathname + url.search,
            process.env.GITHUB_FIXTURE_ORIGIN
        )
        target.searchParams.set('fixture_host', host)
        return originalFetch(target, init)
    }
    return originalFetch(input, init)
}
const db = createDb(process.env.PG_FIXTURE_URL)
try {
    await trace
        .getTracer('fixture')
        .startActiveSpan('foreground.fixture', async (span) => {
            try {
                setSentryRequestContext('private-request-user', {
                    owner: 'private-request-user'
                })
                await originalFetch(
                    process.env.GITHUB_FIXTURE_ORIGIN + '/ordinary-control'
                )
                const service = new SkillDiscoveryService(
                    { get: () => 'private-platform-credential' },
                    {}
                )
                const skillService = new SkillsService(db, service, {}, {})
                Object.assign(skillService, {
                    resolveTarget: async () => ({
                        agent: { id: 'fixture-agent' },
                        runtime: {},
                        framework: 'codex'
                    }),
                    discoveryRepos: async () => [
                        {
                            id: 'fixture',
                            owner: 'private-source-owner',
                            name: 'private-source-repository',
                            branch: 'main',
                            enabled: true,
                            readonly: true,
                            createdAt: null,
                            updatedAt: null
                        }
                    ]
                })
                try {
                    await skillService.install({
                        userId: 'private-request-user',
                        agentId: 'fixture-agent',
                        skillId:
                            'github:private-source-owner/private-source-repository@main:private-path'
                    })
                } catch (error) {
                    const reply = {
                        header: () => reply,
                        status: () => reply,
                        send: (body) => console.log(JSON.stringify(body))
                    }
                    new HttpExceptionFilter(captureApiException).catch(error, {
                        switchToHttp: () => ({ getResponse: () => reply })
                    })
                }
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
