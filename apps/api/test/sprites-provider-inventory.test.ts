import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import { SpritesProvider } from '../src/modules/hosts/providers/sprites.provider'
import { ProviderMachineError } from '../src/modules/hosts/providers/sandbox-provider'

// The sprites inventory: every sprite of the organisation by name, mapped to
// the core's machine view, with sprites.dev's failures in the core's terms.

const provider = {
    id: 'rtp_1',
    kind: 'sprites',
    name: 'org',
    config: { orgSlug: 'fixture-org', orgId: 'org-1', tokenId: 't' }
} as never

const adapterOver = (client: Record<string, unknown>) =>
    new SpritesProvider(
        { register: () => {} } as never,
        {} as never,
        {
            spritesClientForProvider: () => client,
            spritesLoggerFor: () => ({
                debug() {},
                info() {},
                warn() {},
                error() {}
            })
        } as never
    ).inventory

const notFound = () => new SpritesError('not_found', 'sprite not found', 404)

const kindOf = async (call: Promise<unknown>): Promise<string> => {
    try {
        await call
    } catch (err) {
        assert.ok(err instanceof ProviderMachineError)
        return err.kind
    }
    throw new Error('expected a rejection')
}

test('a listing maps every named sprite and counts the account from it', async () => {
    const inventory = adapterOver({
        listSprites: async () => ({
            sprites: [
                {
                    id: 'sprite-1',
                    name: 'sbx-a',
                    status: 'running',
                    version: '0.0.2',
                    environment_version: null,
                    labels: ['team', 7, 'prod'],
                    url: 'https://sbx-a.fixture.test',
                    url_settings: { auth: 'public' },
                    created_at: '2026-10-01T00:00:00Z',
                    updated_at: '2026-10-02T00:00:00Z',
                    last_running_at: '2026-10-03T00:00:00Z'
                },
                { id: 'sprite-2', name: 'sbx-b', status: 'cold' },
                { id: 'sprite-3', status: 'warm' }
            ],
            running_limit: 20,
            warm_limit: 0,
            truncated: false
        })
    })

    const listing = await inventory.list(provider)

    assert.equal(listing.complete, true)
    assert.deepEqual(listing.machines[0], {
        name: 'sbx-a',
        id: 'sprite-1',
        status: 'running',
        power: 'running',
        version: '0.0.2',
        environmentVersion: null,
        labels: ['team', 'prod'],
        url: 'https://sbx-a.fixture.test',
        urlAuth: 'public',
        urlPrivateAccess: null,
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z',
        lastRunningAt: '2026-10-03T00:00:00Z'
    })
    assert.equal(
        listing.machines.length,
        2,
        'a sprite with no name is left out'
    )
    assert.equal(listing.machines[1].power, 'stopped')
    assert.deepEqual(listing.capacity, {
        running: 1,
        suspended: 0,
        stopped: 1,
        runningLimit: 20,
        suspendedLimit: null
    })
})

test('a listing that stopped early is marked incomplete', async () => {
    const inventory = adapterOver({
        listSprites: async () => ({ sprites: [], truncated: true })
    })
    assert.equal((await inventory.list(provider)).complete, false)
})

test('the account is the organisation, and a host owns its recorded or derived name', () => {
    const inventory = adapterOver({})
    assert.equal(inventory.accountKey(provider), 'sprites:org-1')
    assert.equal(
        inventory.accountKey({ id: 'rtp_2', config: {} } as never),
        'provider:rtp_2'
    )
    assert.equal(
        inventory.machineNameOf({
            id: 'sbx_1',
            providerRef: {
                kind: 'sprites',
                spriteName: 'sbx-old',
                spriteId: null
            }
        }),
        'sbx-old'
    )
    assert.equal(
        inventory.machineNameOf({ id: 'sbx_2', providerRef: null }),
        'sbx-2'
    )
})

test('a machine the account does not have reads as null, not as an error', async () => {
    const inventory = adapterOver({
        getSprite: async () => {
            throw notFound()
        }
    })
    assert.equal(await inventory.get(provider, 'sbx-gone'), null)
})

test('a delete of a sprite already gone is done', async () => {
    const inventory = adapterOver({
        deleteSprite: async () => {
            throw notFound()
        }
    })
    await inventory.destroy(provider, 'sbx-gone')
})

test('a delete that timed out is done if the sprite is gone, and reported if not', async () => {
    const timedOut = () =>
        new SpritesError(
            'transient',
            'sprites.dev DELETE timed out after 15000ms'
        )
    const gone = adapterOver({
        deleteSprite: async () => {
            throw timedOut()
        },
        getSprite: async () => {
            throw notFound()
        }
    })
    await gone.destroy(provider, 'sbx-a')

    const still = adapterOver({
        deleteSprite: async () => {
            throw timedOut()
        },
        getSprite: async () => ({
            id: 'sprite-1',
            name: 'sbx-a',
            status: 'cold'
        })
    })
    assert.equal(await kindOf(still.destroy(provider, 'sbx-a')), 'unavailable')
})

test('a restart answers with what sprites.dev said', async () => {
    const asked: string[] = []
    const inventory = adapterOver({
        restartSprite: async (name: string) => {
            asked.push(name)
            return {
                message: 'Restart requested; the machine will reboot shortly.'
            }
        }
    })
    assert.deepEqual(await inventory.restart!(provider, 'sbx-a'), {
        message: 'Restart requested; the machine will reboot shortly.'
    })
    assert.deepEqual(asked, ['sbx-a'])
})

// The route is not in the public API, so its 404 is ambiguous.
test('a 404 from an unlisted route is a missing route when the sprite is there', async () => {
    const present = adapterOver({
        restartSprite: async () => {
            throw notFound()
        },
        getSprite: async () => ({
            id: 'sprite-1',
            name: 'sbx-a',
            status: 'warm'
        })
    })
    assert.equal(
        await kindOf(present.restart!(provider, 'sbx-a')),
        'unsupported'
    )

    const absent = adapterOver({
        restartSprite: async () => {
            throw notFound()
        },
        getSprite: async () => {
            throw notFound()
        }
    })
    assert.equal(await kindOf(absent.restart!(provider, 'sbx-a')), 'not_found')
})

test('an upgrade passes its options and steps through, and an unwatched end is unconfirmed', async () => {
    const sent: unknown[] = []
    const steps: string[] = []
    let accepted = 0
    const inventory = adapterOver({
        upgradeSprite: async (
            name: string,
            body: unknown,
            opts: {
                onAccepted?: () => void
                onEvent?: (event: { type: string }) => void
            }
        ) => {
            sent.push({ name, body })
            opts.onAccepted?.()
            opts.onEvent?.({ type: 'starting_machine' })
            return {
                outcome: 'incomplete',
                targetVersion: '0.0.2',
                message: null,
                lastEvent: 'starting_machine',
                stoppedBecause: 'idle'
            }
        }
    })

    const outcome = await inventory.upgrade!(
        provider,
        'sbx-a',
        { allowStorageMigration: true },
        {
            onAccepted: () => (accepted += 1),
            onStep: (step) => steps.push(step)
        }
    )

    assert.deepEqual(sent, [
        {
            name: 'sbx-a',
            body: { version: undefined, allow_storage_migration: true }
        }
    ])
    assert.equal(accepted, 1)
    assert.deepEqual(steps, ['starting_machine'])
    assert.deepEqual(outcome, {
        outcome: 'unconfirmed',
        targetVersion: '0.0.2',
        message: null,
        lastStep: 'starting_machine'
    })
})

test('sprites.dev failures arrive in the core terms, in its words, redacted', async () => {
    const failing = (err: SpritesError) =>
        adapterOver({
            upgradeSprite: async () => {
                throw err
            },
            getSprite: async () => ({
                id: 'sprite-1',
                name: 'sbx-a',
                status: 'warm'
            })
        })
    const caught = async (err: SpritesError): Promise<ProviderMachineError> => {
        try {
            await failing(err).upgrade!(provider, 'sbx-a', {})
        } catch (thrown) {
            assert.ok(thrown instanceof ProviderMachineError)
            return thrown
        }
        throw new Error('expected a rejection')
    }

    const storage = await caught(
        new SpritesError('conflict', 'sprites.dev POST … → 409', 409, {
            error: 'this upgrade would move the sprite from sbd to juicefs storage; retry with allow_storage_migration=true to migrate it',
            from_variant: 'sbd',
            to_variant: 'juicefs'
        })
    )
    assert.equal(storage.kind, 'storage_migration_required')
    assert.match(storage.message, /^this upgrade would move the sprite/)

    const conflict = await caught(
        new SpritesError('conflict', 'sprites.dev POST … → 409', 409, {
            error: 'an upgrade is already running'
        })
    )
    assert.equal(conflict.kind, 'refused')

    const limited = await caught(
        new SpritesError(
            'quota',
            'sprites.dev POST … → 429',
            429,
            {},
            {
                retryAfterMs: 7000
            }
        )
    )
    assert.equal(limited.kind, 'rate_limited')
    assert.equal(limited.retryAfterMs, 7000)

    const auth = await caught(
        new SpritesError('auth', 'sprites.dev POST … → 401', 401, {
            error: 'token Bearer abcdefghijklmnop0123 revoked'
        })
    )
    assert.equal(auth.kind, 'auth')
    assert.equal(auth.message, 'token [REDACTED] revoked')

    const down = await caught(
        new SpritesError('transient', 'sprites.dev POST … → 503', 503)
    )
    assert.equal(down.kind, 'unavailable')
})
