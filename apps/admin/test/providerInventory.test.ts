import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderMachineSummary } from '@manyfold/shared'
import { ApiError } from '@manyfold/sdk'
import {
    filterMachines,
    machineActionDetail,
    machineActionLabel,
    machineActions,
    machineErrorMessage,
    ranRecently,
    stepLabel,
    tallyMachines
} from '../src/lib/providerInventory'

const machine = (
    name: string,
    extra: Partial<ProviderMachineSummary> = {}
): ProviderMachineSummary => ({
    name,
    id: `sprite-${name}`,
    status: 'cold',
    power: 'stopped',
    version: '0.0.2',
    environmentVersion: null,
    labels: [],
    url: null,
    urlAuth: null,
    urlPrivateAccess: null,
    createdAt: null,
    updatedAt: null,
    lastRunningAt: null,
    host: null,
    ...extra
})

const host = (
    extra: Partial<NonNullable<ProviderMachineSummary['host']>> = {}
) => ({
    id: 'sbx_1',
    name: 'research',
    status: 'ready' as const,
    userId: 'usr_1',
    ownerEmail: 'owner@fixture.test',
    agentsCount: 0,
    providerId: 'rtp_1',
    providerName: 'org',
    ...extra
})

const all = { inventory: true, restartMachine: true, upgradeMachine: true }

test('filters by tracking, power and a search over name, sandbox and owner', () => {
    const machines = [
        machine('sbx-a', { host: host(), power: 'running' }),
        machine('sbx-b'),
        machine('handmade', { power: 'running' })
    ]
    const names = (filters: Parameters<typeof filterMachines>[1]) =>
        filterMachines(machines, filters).map((m) => m.name)

    assert.deepEqual(names({ search: '', tracking: 'tracked', power: 'all' }), [
        'sbx-a'
    ])
    assert.deepEqual(
        names({ search: '', tracking: 'untracked', power: 'all' }),
        ['sbx-b', 'handmade']
    )
    assert.deepEqual(names({ search: '', tracking: 'all', power: 'running' }), [
        'sbx-a',
        'handmade'
    ])
    assert.deepEqual(
        names({ search: 'OWNER@', tracking: 'all', power: 'all' }),
        ['sbx-a']
    )
    assert.deepEqual(
        names({ search: 'research', tracking: 'all', power: 'all' }),
        ['sbx-a']
    )
    assert.deepEqual(tallyMachines(machines), {
        total: 3,
        tracked: 1,
        untracked: 2
    })
})

test('a machine counts as recently run while running or within a day of it', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    assert.equal(ranRecently(machine('a', { power: 'running' }), now), true)
    assert.equal(
        ranRecently(
            machine('a', { lastRunningAt: '2026-10-19T01:00:00Z' }),
            now
        ),
        true
    )
    assert.equal(
        ranRecently(
            machine('a', { lastRunningAt: '2026-10-17T12:00:00Z' }),
            now
        ),
        false
    )
    assert.equal(ranRecently(machine('a'), now), false)
})

test('a sandbox being made or torn down holds restart and upgrade; agents hold delete', () => {
    assert.deepEqual(machineActions(machine('a'), all), {
        restart: true,
        upgrade: true,
        delete: true,
        hostBusy: false,
        agents: 0
    })
    const busy = machineActions(
        machine('a', { host: host({ status: 'provisioning' }) }),
        all
    )
    assert.equal(busy.restart, false)
    assert.equal(busy.upgrade, false)
    assert.equal(busy.delete, true)
    const occupied = machineActions(
        machine('a', { host: host({ agentsCount: 2 }) }),
        all
    )
    assert.equal(occupied.delete, false)
    assert.equal(occupied.agents, 2)
    // What the provider does not offer is never offered.
    const bare = machineActions(machine('a'), {
        inventory: true,
        restartMachine: false,
        upgradeMachine: false
    })
    assert.equal(bare.restart, false)
    assert.equal(bare.upgrade, false)
})

test('API failures read as what an admin can do about them', () => {
    const apiError = (code: string, status: number, message = 'raw') =>
        new ApiError({
            status,
            statusText: '',
            code,
            message,
            serverMessage: message,
            body: ''
        })
    assert.match(
        machineErrorMessage(
            apiError(
                'PROVIDER_MACHINE_STORAGE_MIGRATION_REQUIRED',
                409,
                'moves storage'
            )
        ),
        /Allow a storage migration.*moves storage/
    )
    assert.match(
        machineErrorMessage(apiError('HOST_NOT_EMPTY', 409)),
        /still has agents/
    )
    assert.match(
        machineErrorMessage(apiError('PROVIDER_UNAVAILABLE', 503, 'timed out')),
        /did not answer: timed out/
    )
    assert.equal(
        machineErrorMessage(apiError('SOMETHING_NEW', 500, 'as said')),
        'as said'
    )
    assert.equal(machineErrorMessage(new Error('network down')), 'network down')
})

test('an audit row reads as its action and the versions it moved between', () => {
    assert.equal(
        machineActionLabel('runtime_provider.machine.upgrade.succeeded'),
        'Upgraded'
    )
    assert.equal(machineActionLabel('something.else'), 'something.else')
    assert.equal(
        machineActionDetail({
            fromVersion: '0.0.1-rc44',
            targetVersion: '0.0.2'
        }),
        '0.0.1-rc44 → 0.0.2'
    )
    assert.equal(
        machineActionDetail({
            fromVersion: '0.0.2',
            requestedVersion: '0.0.1-rc44',
            allowStorageMigration: true
        }),
        '0.0.2 → 0.0.1-rc44 · storage migration allowed'
    )
    assert.equal(
        machineActionDetail({
            fromVersion: '0.0.2',
            reason: 'Upgrade skipped'
        }),
        '0.0.2 · Upgrade skipped'
    )
    assert.equal(
        machineActionDetail({ via: 'host_lifecycle' }),
        'with its sandbox'
    )
    assert.equal(stepLabel('starting_machine'), 'starting machine')
})
