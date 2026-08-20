import type { FrameworkInstallSource } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import { BootstrapError } from '../src/modules/agents/bootstrap/framework-bootstrap'
import type { BootstrapContext } from '../src/modules/agents/bootstrap/framework-bootstrap'
import type {
    SpriteServiceBootstrap,
    SpriteServiceBootstrapResult
} from '../src/modules/agents/bootstrap/sprite-framework-bootstrap'

const emptyProvisioner = (): SpritesProvisioner =>
    new SpritesProvisioner(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

interface FakeBootstrap extends SpriteServiceBootstrap {
    versions: Array<string | null>
}

// Fails the first run with `failWith`, succeeds after. Records the version each
// run was asked to install so we can see what the retry fell back to.
const fakeBootstrap = (failWith: Error | null): FakeBootstrap => {
    const versions: Array<string | null> = []
    let calls = 0
    return {
        framework: 'openclaw',
        versions,
        run: async (ctx: BootstrapContext) => {
            versions.push(ctx.frameworkVersion ?? null)
            calls += 1
            if (calls === 1 && failWith) throw failWith
            return {
                homeDir: '/home/sprite/.openclaw',
                serviceName: 'openclaw',
                generatedCredentials: { gatewayToken: `token-${calls}` }
            } as SpriteServiceBootstrapResult
        },
        restart: async () => {}
    }
}

const ctxFor = (
    version: string | null,
    source: FrameworkInstallSource
): BootstrapContext =>
    ({
        agentId: 'agent_1',
        runtimeId: 'rt_1',
        userId: 'user_1',
        spriteName: 'sprite-1',
        mountPath: '/workspace',
        client: {} as never,
        logger: {
            debug: (): void => {},
            info: (): void => {},
            warn: (): void => {},
            error: (): void => {}
        },
        frameworkVersion: version,
        frameworkVersionSource: source
    }) as BootstrapContext

const runService = (
    bootstrap: SpriteServiceBootstrap,
    ctx: BootstrapContext
): Promise<SpriteServiceBootstrapResult & { installedVersion: string | null }> =>
    (
        emptyProvisioner() as never as {
            runServiceBootstrap: (
                b: SpriteServiceBootstrap,
                c: BootstrapContext,
                creds: unknown
            ) => Promise<
                SpriteServiceBootstrapResult & { installedVersion: string | null }
            >
        }
    ).runServiceBootstrap(bootstrap, ctx, {})

// A daemon has no pre-installed binary to fall back on, so honouring "keep
// creating agents when the newest release is broken" means re-running the
// bootstrap unpinned.
test('a broken latest release falls back to the framework built-in version', async () => {
    const bootstrap = fakeBootstrap(
        new BootstrapError('openclaw-install', 'npm 404')
    )
    const result = await runService(bootstrap, ctxFor('1.9.9', 'latest'))
    assert.deepEqual(bootstrap.versions, ['1.9.9', null])
    // null, not '1.9.9': the fallback installed something we didn't choose, and
    // recording the version we failed to install would be a lie on the runtime row.
    assert.equal(result.installedVersion, null)
})

// THE brick guard. Every daemon bootstrap upserts a service and mints tokens
// AFTER the install step; `upsertService` alone does not propagate new env, so a
// second run would leave the sprite on the first run's token while we persist the
// second one. Only an install-step failure may retry.
test('a failure past the install step never retries', async () => {
    const bootstrap = fakeBootstrap(
        new BootstrapError('openclaw-start', 'service failed to start')
    )
    await assert.rejects(runService(bootstrap, ctxFor('1.9.9', 'latest')), {
        message: 'service failed to start'
    })
    assert.deepEqual(bootstrap.versions, ['1.9.9'])
})

// A plain Error carries no step, so we cannot prove nothing was mutated.
test('a non-BootstrapError failure never retries', async () => {
    const bootstrap = fakeBootstrap(new Error('socket hang up'))
    await assert.rejects(runService(bootstrap, ctxFor('1.9.9', 'latest')), {
        message: 'socket hang up'
    })
    assert.deepEqual(bootstrap.versions, ['1.9.9'])
})

// An asked-for version must fail loud — silently installing a different one would
// make the admin pin a lie.
for (const source of ['explicit', 'admin'] as const) {
    test(`a ${source} pin does not fall back`, async () => {
        const bootstrap = fakeBootstrap(
            new BootstrapError('openclaw-install', 'npm 404')
        )
        await assert.rejects(runService(bootstrap, ctxFor('1.9.9', source)), {
            message: 'npm 404'
        })
        assert.deepEqual(bootstrap.versions, ['1.9.9'])
    })
}

// The happy path records the tag we asked for; the v-prefix is stripped so it
// compares against catalog/probe values.
test('a successful install records the requested version without a v prefix', async () => {
    const bootstrap = fakeBootstrap(null)
    const result = await runService(bootstrap, ctxFor('v2026.6.5', 'latest'))
    assert.equal(result.installedVersion, '2026.6.5')
})

// The version fallback must not become a repository fallback. Both runs clone
// the same repo, so a retry cannot silently land on a different codebase — and
// the second run's `null` version resolves against the repo it was given.
test('the unpinned retry keeps the repository it was given', async () => {
    const repos: Array<string | null> = []
    const versions: Array<string | null> = []
    let calls = 0
    const bootstrap: SpriteServiceBootstrap = {
        framework: 'openclaw',
        run: async (ctx: BootstrapContext) => {
            repos.push(ctx.frameworkRepo ?? null)
            versions.push(ctx.frameworkVersion ?? null)
            calls += 1
            if (calls === 1)
                throw new BootstrapError('openclaw-install', 'npm 404')
            return {
                homeDir: '/home/sprite/.openclaw',
                serviceName: 'openclaw',
                generatedCredentials: { gatewayToken: `token-${calls}` }
            } as SpriteServiceBootstrapResult
        },
        restart: async () => {}
    }
    const ctx = {
        ...ctxFor('1.9.9', 'latest'),
        frameworkRepo: 'protagolabs/NarraNexus'
    } as BootstrapContext

    await runService(bootstrap, ctx)

    assert.deepEqual(versions, ['1.9.9', null])
    assert.deepEqual(repos, ['protagolabs/NarraNexus', 'protagolabs/NarraNexus'])
})
