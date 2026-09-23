import assert from 'node:assert/strict'
import test from 'node:test'
import { NotFoundException } from '@nestjs/common'
import { AutomationsService } from '../src/modules/automations/automations.service'

const service = (rows: unknown[][] = []) =>
    new AutomationsService(
        {
            select: () => {
                const query = {
                    from: () => query,
                    innerJoin: () => query,
                    where: () => query,
                    orderBy: () => query,
                    limit: async () => rows.shift() ?? []
                }
                return query
            }
        } as never,
        {} as never,
        {
            get: (key: string) =>
                key === 'MF_WEB_URL'
                    ? 'https://workbench.example.test'
                    : undefined
        } as never,
        {} as never
    )

test('UI resolver uses the deployment Web origin and exact run conversation', async () => {
    const api = service([
        [{ automation: { id: 'auto-1', agentId: 'rebound-agent' }, agent: {} }],
        [
            { id: 'run-1', agentId: 'agent-1', chatSessionId: 'session-1' },
            { id: 'run-2', agentId: 'agent-1', chatSessionId: null }
        ]
    ])
    assert.deepEqual(await api.ui('owner', 'auto-1'), {
        resource: 'automation',
        resourceId: 'auto-1',
        url: 'https://workbench.example.test/automations/auto-1',
        runs: [
            {
                runId: 'run-1',
                sessionId: 'session-1',
                url: 'https://workbench.example.test/agents/agent-1/chat?sessionId=session-1'
            }
        ]
    })
    assert.deepEqual(await api.ui('owner'), {
        resource: 'automation',
        url: 'https://workbench.example.test/automations'
    })
})

test('UI resolver cannot return a link for an inaccessible automation', async () => {
    const api = service()
    await assert.rejects(api.ui('another-user', 'auto-1'), NotFoundException)
})
