import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeAccessSummary } from '@manyfold/shared'
import { resourceUsageRows } from '../src/lib/resourceUsageRows'

const access: RuntimeAccessSummary = {
    userId: 'fixture',
    plan: {
        id: 'self_hosted',
        name: 'Self-hosted',
        maxAgentsProvisioned: 10,
        maxConcurrentActive: 8,
        maxStorageGb: 100,
        monthlyActiveHoursIncluded: null,
        maxAlwaysOnlineRuntimes: 3,
        maxAlwaysOnlineAgents: 4,
        maxChannels: 5,
        maxAutomations: 6,
        maxAutomationRunsMonthly: null,
        messageHistoryRetentionDays: null,
        monthlyApiRequestLimit: null
    },
    statefulSandboxLimit: 12,
    statefulSandboxUsage: 2,
    statefulSandboxRemaining: 10,
    alwaysOnlineRuntimeBonus: 2,
    alwaysOnlineRuntimeLimit: 5,
    alwaysOnlineRuntimesUsed: 1,
    alwaysOnlineRuntimesRemaining: 4,
    alwaysOnlineAgentsLimit: 6,
    alwaysOnlineAgentsUsed: 3,
    alwaysOnlineAgentsRemaining: 3,
    persistentContainersUsed: 0,
    localDaemonsUsed: 1,
    cloudComputerEnabled: false,
    activeSandboxUsage: 1,
    activeSandboxRemaining: 7,
    storageBytesTotal: 1_500_000_000,
    usagePeriod: {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
        source: 'calendar'
    },
    activeHoursThisPeriod: null,
    activeHoursLimit: null,
    activeHoursBonus: 0,
    channelsUsed: 2,
    automationsUsed: 3,
    automationRunsThisPeriod: 9,
    apiRequestsThisPeriod: 42,
    activeContainerSubscriptions: 0
}

test('resource summary uses effective grants, preserves unknown usage and nullable limits', () => {
    const rows = resourceUsageRows(access)
    assert.equal(rows.length, 10)
    const byLabel = Object.fromEntries(
        rows.map((row) => [row.labelKey.split('.').at(-1), row])
    )
    assert.equal(byLabel.quotaAgents.limit, 12)
    assert.equal(byLabel.quotaAlwaysOnlineRuntimes.limit, 5)
    assert.equal(byLabel.quotaAlwaysOnlineAgents.limit, 6)
    assert.equal(byLabel.quotaActiveHours.used, null)
    assert.equal(byLabel.quotaActiveHours.limit, null)
    assert.equal(byLabel.quotaStorage.used, 1_500_000_000)
    assert.equal(byLabel.quotaStorage.limit, 100_000_000_000)
    assert.equal(byLabel.quotaAutomationRuns.limit, null)
    assert.equal(byLabel.quotaApiRequests.used, 42)
    const finite = resourceUsageRows({
        ...access,
        activeHoursThisPeriod: 4,
        activeHoursLimit: 7
    })
    assert.equal(finite.find((row) => row.unit === 'hours')?.limit, 7)
})
