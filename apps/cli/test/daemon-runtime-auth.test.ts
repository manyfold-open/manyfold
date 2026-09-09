import test from 'node:test'
import assert from 'node:assert/strict'
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    stat,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createObjectId } from '@manyfold/shared'
import { rpcHandler } from '../src/daemon/rpc'
import type { RpcContext } from '../src/daemon/ws-client'
import { RuntimeAuthManager } from '../src/daemon/runtime-auth/manager'
import { ProfileBusyError } from '../src/daemon/runtime-auth/lock'

// Runtime auth profiles on the daemon: the store lives under the throwaway
// MF_CONFIG_DIR, the "native" CLI homes under a throwaway HOME, and the
// vendor CLIs are shell stubs on a throwaway PATH — no real credential,
// profile or Keychain entry is touched, and no network call is made
// (an empty view carries no token, so the account probe never fetches).

const ctx = (refId: string): RpcContext => ({
    refId,
    sendEvent: () => {},
    onCancel: () => {}
})

interface Sandbox {
    base: string
    home: string
    configDir: string
    daemonId: string
    runtimeId: string
    bin: string
}

const withSandbox = async (
    fn: (sb: Sandbox) => Promise<void>
): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-runtime-auth-'))
    const prior = {
        MF_CONFIG_DIR: process.env.MF_CONFIG_DIR,
        MF_PROFILE: process.env.MF_PROFILE,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        CODEX_HOME: process.env.CODEX_HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
    }
    const home = join(base, 'home')
    const configDir = join(base, 'config')
    const bin = join(base, 'bin')
    await mkdir(join(home, '.codex'), { recursive: true })
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(join(home, '.gemini'), { recursive: true })
    await mkdir(bin, { recursive: true })
    process.env.MF_CONFIG_DIR = configDir
    delete process.env.MF_PROFILE
    process.env.HOME = home
    delete process.env.CODEX_HOME
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
    const daemonId = createObjectId('daemonHost')
    const runtimeId = createObjectId('agentRuntime')
    // The registration the manager scopes the store by.
    const daemonDir = join(configDir, 'profiles', 'default', 'daemon')
    await mkdir(daemonDir, { recursive: true })
    await writeFile(
        join(daemonDir, 'config.json'),
        JSON.stringify({
            apiUrl: 'http://127.0.0.1:1/api',
            token: 'unused',
            daemonId,
            daemonUuid: 'uuid'
        })
    )
    try {
        await fn({ base, home, configDir, daemonId, runtimeId, bin })
    } finally {
        for (const [key, value] of Object.entries(prior))
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
    }
}

const stubCli = async (
    bin: string,
    name: string,
    script: string
): Promise<void> => {
    const path = join(bin, name)
    await writeFile(path, `#!/bin/sh\n${script}\n`)
    await chmod(path, 0o755)
}

const isSymlink = async (path: string): Promise<boolean> =>
    (await lstat(path)).isSymbolicLink()

test('auth.create builds a codex view that shares state dirs and config with the native home', async () => {
    await withSandbox(async (sb) => {
        await writeFile(
            join(sb.home, '.codex', 'config.toml'),
            'model_reasoning_effort = "medium"\n'
        )
        const profileId = createObjectId('runtimeAuthProfile')
        const created = await rpcHandler(
            'auth.create',
            {
                framework: 'codex',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'subscription'
            },
            ctx('create-1')
        )
        assert.equal(created.ok, true, created.error)
        assert.deepEqual(created.payload, {
            profileId,
            generation: 0,
            created: true
        })
        const view = join(
            sb.configDir,
            'runtime-auth',
            sb.daemonId,
            sb.runtimeId,
            'profiles',
            profileId,
            'view'
        )
        assert.equal((await stat(view)).mode & 0o777, 0o700)
        for (const dir of [
            'sessions',
            'archived_sessions',
            'thread-writer-locks',
            'skills'
        ])
            assert.equal(
                await readlink(join(view, dir)),
                join(sb.home, '.codex', dir),
                dir
            )
        assert.equal(
            await readlink(join(view, 'config.toml')),
            join(sb.home, '.codex', 'config.toml')
        )
        // A config write through the view lands in the native file.
        await writeFile(
            join(view, 'config.toml'),
            'model_reasoning_effort = "high"\n'
        )
        assert.match(
            await readFile(join(sb.home, '.codex', 'config.toml'), 'utf8'),
            /high/
        )
        assert.ok(
            await isSymlink(join(view, 'config.toml')),
            'link survives a write-through'
        )
        // auth.json is the profile's own: absent until a login stores one.
        await assert.rejects(stat(join(view, 'auth.json')))
        // Idempotent.
        const again = await rpcHandler(
            'auth.create',
            {
                framework: 'codex',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'subscription'
            },
            ctx('create-2')
        )
        assert.deepEqual(again.payload, {
            profileId,
            generation: 0,
            created: false
        })
    })
})

test('auth.create seeds the claude view with a .claude.json projection minus the native identity', async () => {
    await withSandbox(async (sb) => {
        await writeFile(
            join(sb.home, '.claude.json'),
            JSON.stringify({
                hasCompletedOnboarding: true,
                numStartups: 3,
                oauthAccount: { emailAddress: 'native@example.invalid' }
            })
        )
        await writeFile(
            join(sb.home, '.claude', 'settings.json'),
            '{"model":"sonnet"}'
        )
        const profileId = createObjectId('runtimeAuthProfile')
        const created = await rpcHandler(
            'auth.create',
            {
                framework: 'claude-code',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'subscription'
            },
            ctx('create-claude')
        )
        assert.equal(created.ok, true, created.error)
        const view = join(
            sb.configDir,
            'runtime-auth',
            sb.daemonId,
            sb.runtimeId,
            'profiles',
            profileId,
            'view'
        )
        const projection = JSON.parse(
            await readFile(join(view, '.claude.json'), 'utf8')
        )
        assert.equal(projection.hasCompletedOnboarding, true)
        assert.equal(projection.numStartups, 3)
        assert.equal('oauthAccount' in projection, false)
        assert.equal(
            await readlink(join(view, 'settings.json')),
            join(sb.home, '.claude', 'settings.json')
        )
        assert.equal(
            await readlink(join(view, 'projects')),
            join(sb.home, '.claude', 'projects')
        )
        // The native identity record is untouched.
        const native = JSON.parse(
            await readFile(join(sb.home, '.claude.json'), 'utf8')
        )
        assert.equal(native.oauthAccount.emailAddress, 'native@example.invalid')
    })
})

test('auth.list scopes by framework and reports an unsigned profile without calling a vendor', async () => {
    await withSandbox(async (sb) => {
        const codexId = createObjectId('runtimeAuthProfile')
        const claudeId = createObjectId('runtimeAuthProfile')
        for (const [framework, profileId] of [
            ['codex', codexId],
            ['claude-code', claudeId]
        ] as const)
            assert.equal(
                (
                    await rpcHandler(
                        'auth.create',
                        {
                            framework,
                            runtimeId: sb.runtimeId,
                            profileId,
                            authMethod: 'subscription'
                        },
                        ctx('c')
                    )
                ).ok,
                true
            )
        const cheap = await rpcHandler(
            'auth.list',
            { framework: 'codex', runtimeId: sb.runtimeId, probe: false },
            ctx('l1')
        )
        assert.equal(cheap.ok, true, cheap.error)
        const cheapProfiles = (
            cheap.payload as {
                profiles: Array<{ profileId: string; probe: unknown }>
            }
        ).profiles
        assert.deepEqual(
            cheapProfiles.map((p) => p.profileId),
            [codexId]
        )
        assert.equal(cheapProfiles[0].probe, null)
        assert.equal((cheap.payload as { ambient: unknown }).ambient, null)

        // A probe on an empty view: identity null, no token, so no fetch.
        process.env.ANTHROPIC_API_KEY = 'ambient-key-must-not-count'
        const probed = await rpcHandler(
            'auth.list',
            { framework: 'claude-code', runtimeId: sb.runtimeId },
            ctx('l2')
        )
        assert.equal(probed.ok, true, probed.error)
        const [claude] = (
            probed.payload as { profiles: Array<Record<string, unknown>> }
        ).profiles
        assert.equal(claude.profileId, claudeId)
        const probe = claude.probe as {
            identity: unknown
            tokenSource: string
            credentialFacts: { envToken: boolean } | null
        }
        assert.equal(probe.identity, null)
        assert.equal(probe.tokenSource, 'none')
        assert.equal(
            probe.credentialFacts?.envToken,
            false,
            'ambient env is not a credential for a profile'
        )
    })
})

test('unparseable ids never reach the filesystem', async () => {
    await withSandbox(async (sb) => {
        for (const profileId of [
            '../../etc',
            'rap_short',
            'agt_' + 'a'.repeat(26),
            ''
        ])
            assert.equal(
                (
                    await rpcHandler(
                        'auth.create',
                        {
                            framework: 'codex',
                            runtimeId: sb.runtimeId,
                            profileId,
                            authMethod: 'subscription'
                        },
                        ctx('bad')
                    )
                ).ok,
                false,
                profileId
            )
        const bad = await rpcHandler(
            'auth.list',
            { framework: 'codex', runtimeId: '../x' },
            ctx('bad-rt')
        )
        assert.equal(bad.ok, false)
        await assert.rejects(
            stat(join(sb.configDir, 'runtime-auth', sb.daemonId, '..'))
        )
    })
})

test('fs.write into a profile view is admitted by the containment', async () => {
    await withSandbox(async (sb) => {
        const profileId = createObjectId('runtimeAuthProfile')
        await rpcHandler(
            'auth.create',
            {
                framework: 'claude-code',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'subscription'
            },
            ctx('c')
        )
        const view = join(
            sb.configDir,
            'runtime-auth',
            sb.daemonId,
            sb.runtimeId,
            'profiles',
            profileId,
            'view'
        )
        const written = await rpcHandler(
            'fs.write',
            { path: join(view, '.claude.json'), content: '{"mcpServers":{}}' },
            ctx('w')
        )
        assert.equal(written.ok, true, written.error)
        const outside = await rpcHandler(
            'fs.write',
            {
                path: join(sb.configDir, 'runtime-auth', 'stray.txt'),
                content: 'x'
            },
            ctx('w2')
        )
        assert.equal(
            outside.ok,
            true,
            'the auth root itself is a declared root'
        )
        await assert.rejects(
            rpcHandler(
                'fs.write',
                {
                    path: join(
                        sb.configDir,
                        'profiles',
                        'default',
                        'daemon',
                        'config.json'
                    ),
                    content: '{}'
                },
                ctx('w3')
            ),
            /outside allowed roots/,
            'the daemon state dir stays out of reach'
        )
    })
})

test('auth.logout runs the vendor logout in the profile context, journals the operation and bumps the generation', async () => {
    await withSandbox(async (sb) => {
        await stubCli(
            sb.bin,
            'codex',
            'printf "%s\\n" "$CODEX_HOME" > "$CODEX_HOME/.logout-seen"; [ -z "$OPENAI_API_KEY" ] || exit 9; rm -f "$CODEX_HOME/auth.json"'
        )
        process.env.OPENAI_API_KEY = 'ambient'
        const profileId = createObjectId('runtimeAuthProfile')
        await rpcHandler(
            'auth.create',
            {
                framework: 'codex',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'subscription'
            },
            ctx('c')
        )
        const view = join(
            sb.configDir,
            'runtime-auth',
            sb.daemonId,
            sb.runtimeId,
            'profiles',
            profileId,
            'view'
        )
        await writeFile(join(view, 'auth.json'), '{"auth_mode":"chatgpt"}', {
            mode: 0o600
        })
        const operationId = createObjectId('runtimeAuthOperation')
        const res = await rpcHandler(
            'auth.logout',
            {
                framework: 'codex',
                runtimeId: sb.runtimeId,
                profileId,
                operationId,
                mode: 'sign-out'
            },
            ctx('lo')
        )
        assert.equal(res.ok, true, res.error)
        assert.deepEqual(res.payload, {
            signedOut: true,
            removed: false,
            revoke: 'unknown',
            generation: 1,
            logoutError: null
        })
        assert.equal(
            (await readFile(join(view, '.logout-seen'), 'utf8')).trim(),
            view,
            'CODEX_HOME pointed at the view; ambient OPENAI_API_KEY stripped'
        )
        await assert.rejects(stat(join(view, 'auth.json')))
        const op = await rpcHandler(
            'auth.operation',
            { runtimeId: sb.runtimeId, operationId },
            ctx('op')
        )
        assert.equal(op.ok, true)
        assert.equal((op.payload as { status: string }).status, 'succeeded')
        assert.equal((op.payload as { kind: string }).kind, 'logout')
        // Metadata survives a sign-out; remove deletes the whole profile.
        const listed = await rpcHandler(
            'auth.list',
            { framework: 'codex', runtimeId: sb.runtimeId, probe: false },
            ctx('l')
        )
        assert.equal(
            (listed.payload as { profiles: Array<{ generation: number }> })
                .profiles[0].generation,
            1
        )
        const removed = await rpcHandler(
            'auth.logout',
            {
                framework: 'codex',
                runtimeId: sb.runtimeId,
                profileId,
                operationId: createObjectId('runtimeAuthOperation'),
                mode: 'remove'
            },
            ctx('rm')
        )
        assert.equal(removed.ok, true, removed.error)
        assert.equal((removed.payload as { removed: boolean }).removed, true)
        await assert.rejects(stat(view))
        assert.equal(
            (await stat(join(sb.home, '.codex'))).isDirectory(),
            true,
            'shared native dir survives the remove'
        )
        delete process.env.OPENAI_API_KEY
    })
})

test('prepareLogin composes the profile context, holds the lock, and judges the outcome from the view', async () => {
    await withSandbox(async (sb) => {
        process.env.ANTHROPIC_API_KEY = 'ambient'
        const profileId = createObjectId('runtimeAuthProfile')
        await rpcHandler(
            'auth.create',
            {
                framework: 'claude-code',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'subscription'
            },
            ctx('c')
        )
        const manager = new RuntimeAuthManager(
            { daemonId: sb.daemonId, runtimeId: sb.runtimeId },
            {
                credentialFacts: async () => null,
                cliVersion: async () => '2.1.259',
                fetch: async () => {
                    throw new Error('no vendor call expected')
                },
                now: Date.now,
                platform: 'linux',
                env: process.env
            }
        )
        const view = join(
            sb.configDir,
            'runtime-auth',
            sb.daemonId,
            sb.runtimeId,
            'profiles',
            profileId,
            'view'
        )
        const opA = createObjectId('runtimeAuthOperation')
        const login = await manager.prepareLogin('claude-code', profileId, opA)
        assert.deepEqual(login.command, [
            'sh',
            '-c',
            'cat | claude auth login --claudeai'
        ])
        assert.equal(login.env.CLAUDE_CONFIG_DIR, view)
        assert.equal(
            'ANTHROPIC_API_KEY' in login.env,
            false,
            'ambient vendor env is stripped'
        )
        assert.equal(
            login.env.PATH,
            process.env.PATH,
            'non-auth env is inherited'
        )
        await assert.rejects(
            manager.prepareLogin(
                'claude-code',
                profileId,
                createObjectId('runtimeAuthOperation')
            ),
            (err: unknown) => err instanceof ProfileBusyError
        )
        // Shell closed with nothing stored → failed, lock released.
        const failed = await login.finish(0)
        assert.equal(failed.status, 'failed')
        assert.equal(failed.resultCode, 'login_incomplete')
        const opB = createObjectId('runtimeAuthOperation')
        const second = await manager.prepareLogin('claude-code', profileId, opB)
        await writeFile(
            join(view, '.claude.json'),
            JSON.stringify({
                oauthAccount: {
                    emailAddress: 'a@example.invalid',
                    accountUuid: 'u1'
                }
            })
        )
        const ok = await second.finish(0)
        assert.equal(ok.status, 'succeeded')
        const listed = await manager.list('claude-code', true)
        assert.equal(listed.profiles[0].generation, 1)
        assert.ok(listed.profiles[0].lastLoginAt)
        assert.equal(
            listed.profiles[0].probe?.identity?.email,
            'a@example.invalid'
        )
        assert.equal(
            listed.ambient?.identity,
            null,
            'native home has no identity record'
        )
        delete process.env.ANTHROPIC_API_KEY
    })
})
