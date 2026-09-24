import test from 'node:test'
import assert from 'node:assert/strict'
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rm,
    stat,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createObjectId } from '@manyfold/shared'
import { daemonActivitySnapshot, rpcHandler } from '../src/daemon/rpc'
import { execStreams, readFinal, readMeta } from '../src/daemon/exec-buffer'
import { daemonPaths } from '../src/daemon/config'
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

const barrier = () => {
    let open!: () => void
    const reached = new Promise<void>((resolve) => {
        open = resolve
    })
    return { reached, open }
}

const within = async <T>(pending: Promise<T>, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`timed out: ${label}`)),
                    10_000
                )
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

interface Sandbox {
    base: string
    home: string
    configDir: string
    daemonId: string
    runtimeId: string
    bin: string
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
    // The sealed test env fails a run that reaches a real vendor CLI; every
    // probe spawns `<cli> --version`, so the three binaries are stubs here.
    for (const [name, version] of [
        ['claude', '2.1.259 (Claude Code)'],
        ['codex', 'codex-cli 0.153.4'],
        ['gemini', '0.58.0'],
        ['pi', '0.87.1']
    ])
        await stubCli(
            bin,
            name,
            `[ "$1" = "--version" ] && { echo "${version}"; exit 0; }; exit 0`
        )
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

// pi keeps every sign-in in its agent dir, so a pi profile's view IS an agent
// dir: the machine's entries linked in, auth.json its own.
test('a pi profile view links the machine agent dir, keeps its own auth.json, and counts only a real sign-in', async () => {
    await withSandbox(async (sb) => {
        process.env.ANTHROPIC_API_KEY = 'ambient'
        const native = join(sb.home, '.pi', 'agent')
        await mkdir(join(native, 'skills', 'one'), { recursive: true })
        await writeFile(join(native, 'settings.json'), '{}')
        await writeFile(join(native, 'trust.json'), '{}')
        await writeFile(
            join(native, 'auth.json'),
            JSON.stringify({ anthropic: { type: 'api_key', key: 'native' } })
        )
        const profileId = createObjectId('runtimeAuthProfile')
        const created = await rpcHandler(
            'auth.create',
            {
                framework: 'pi',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'subscription'
            },
            ctx('c')
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
        for (const name of ['settings.json', 'trust.json', 'skills', 'sessions'])
            assert.equal(await readlink(join(view, name)), join(native, name), name)
        // Write-through even before the machine has one.
        assert.equal(
            await readlink(join(view, 'models.json')),
            join(native, 'models.json')
        )
        await assert.rejects(lstat(join(view, 'auth.json')), 'no native sign-in')

        const manager = new RuntimeAuthManager(
            { daemonId: sb.daemonId, runtimeId: sb.runtimeId },
            {
                credentialFacts: async () => null,
                cliVersion: async () => '0.87.1',
                fetch: async () => {
                    throw new Error('no vendor call expected')
                },
                now: Date.now,
                platform: 'linux',
                env: process.env
            }
        )
        const login = await manager.prepareLogin(
            'pi',
            profileId,
            createObjectId('runtimeAuthOperation')
        )
        assert.deepEqual(login.command, ['pi'])
        assert.equal(login.env.PI_CODING_AGENT_DIR, view)
        assert.equal('ANTHROPIC_API_KEY' in login.env, false)
        // pi writes `{}` the first time it merely reads auth.json; that is
        // not a sign-in, for the login verdict or for an execution.
        await writeFile(join(view, 'auth.json'), '{}')
        assert.equal((await login.finish(0)).resultCode, 'login_incomplete')
        await assert.rejects(
            manager.executionContext('pi', profileId, 'exec:x'),
            /auth_reauth_required/
        )
        const second = await manager.prepareLogin(
            'pi',
            profileId,
            createObjectId('runtimeAuthOperation')
        )
        await writeFile(
            join(view, 'auth.json'),
            JSON.stringify({
                anthropic: {
                    type: 'oauth',
                    access: 'a',
                    refresh: 'r',
                    expires: Date.now() + 3_600_000
                }
            })
        )
        assert.equal((await second.finish(0)).status, 'succeeded')
        // An entry the machine gained since is linked in before the run, one
        // it dropped is unlinked — but what a TUI writes for good stays the
        // machine's path even while the machine has none.
        await writeFile(join(native, 'keybindings.json'), '{}')
        await rm(join(native, 'skills'), { recursive: true })
        await rm(join(native, 'trust.json'))
        const context = await manager.executionContext('pi', profileId, 'exec:y')
        try {
            assert.equal(context.env.PI_CODING_AGENT_DIR, view)
            assert.equal(context.dirs.piDir, view)
            assert.equal(
                await readlink(join(view, 'keybindings.json')),
                join(native, 'keybindings.json')
            )
            await assert.rejects(lstat(join(view, 'skills')))
            assert.equal(
                await readlink(join(view, 'trust.json')),
                join(native, 'trust.json')
            )
        } finally {
            await context.release()
        }
        // The machine's own sign-in was never touched.
        assert.match(await readFile(join(native, 'auth.json'), 'utf8'), /native/)
        delete process.env.ANTHROPIC_API_KEY
    })
})

test('a pi profile takes no stored API key — pi keeps keys through its own /login', async () => {
    await withSandbox(async (sb) => {
        const result = await rpcHandler(
            'auth.create',
            {
                framework: 'pi',
                runtimeId: sb.runtimeId,
                profileId: createObjectId('runtimeAuthProfile'),
                authMethod: 'api-key',
                apiKey: 'sk-should-not-land'
            },
            ctx('c')
        )
        assert.equal(result.ok, false)
        assert.equal(result.error, 'auth_api_key_unsupported')
    })
})

// ---- P2: executions under a profile --------------------------------------

const profileSelection = (
    sb: Sandbox,
    framework: string,
    profileId: string
): Record<string, unknown> => ({
    mode: 'profile',
    framework,
    runtimeId: sb.runtimeId,
    profileId,
    bindingVersion: 1
})

test('exec.start under a codex profile runs in the view with ambient vendor env stripped and sqlite pinned to the native home', async () => {
    await withSandbox(async (sb) => {
        process.env.OPENAI_API_KEY = 'ambient-daemon-key'
        process.env.ANTHROPIC_API_KEY = 'ambient-claude-key'
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
        await writeFile(
            join(view, 'auth.json'),
            '{"auth_mode":"chatgpt","tokens":{"access_token":"x"}}',
            { mode: 0o600 }
        )
        const out = join(sb.base, 'env.txt')
        const result = await rpcHandler(
            'exec.start',
            {
                cmd: ['sh', '-c', 'env > "$OUT"'],
                env: {
                    OUT: out,
                    OPENAI_API_KEY: 'from-agent-extras',
                    KEEP_ME: 'yes'
                },
                authSelection: profileSelection(sb, 'codex', profileId)
            },
            ctx('exec-profile')
        )
        assert.equal(result.ok, true, result.error)
        const env = Object.fromEntries(
            (await readFile(out, 'utf8'))
                .split('\n')
                .filter(Boolean)
                .map((line) => [
                    line.slice(0, line.indexOf('=')),
                    line.slice(line.indexOf('=') + 1)
                ])
        )
        assert.equal(env.CODEX_HOME, view)
        assert.equal(env.CODEX_SQLITE_HOME, join(sb.home, '.codex'))
        assert.equal(
            'OPENAI_API_KEY' in env,
            false,
            'neither the daemon nor the agent env may outrank the profile'
        )
        assert.equal('ANTHROPIC_API_KEY' in env, false)
        assert.equal(
            env.KEEP_ME,
            'yes',
            'non-auth agent env still reaches the child'
        )
        delete process.env.OPENAI_API_KEY
        delete process.env.ANTHROPIC_API_KEY
    })
})

test('exec.start with an inherited selection is byte-for-byte the old behaviour', async () => {
    await withSandbox(async (sb) => {
        process.env.OPENAI_API_KEY = 'ambient-daemon-key'
        const out = join(sb.base, 'env-inherited.txt')
        const result = await rpcHandler(
            'exec.start',
            {
                cmd: ['sh', '-c', 'env > "$OUT"'],
                env: { OUT: out, ANTHROPIC_API_KEY: 'from-agent-extras' },
                authSelection: { mode: 'inherited' }
            },
            ctx('exec-inherited')
        )
        assert.equal(result.ok, true, result.error)
        const text = await readFile(out, 'utf8')
        assert.match(text, /^OPENAI_API_KEY=ambient-daemon-key$/m)
        assert.match(text, /^ANTHROPIC_API_KEY=from-agent-extras$/m)
        assert.doesNotMatch(text, /^CODEX_HOME=/m)
        delete process.env.OPENAI_API_KEY
    })
})

test('a profile with no stored credential refuses to run rather than fall back to the native sign-in', async () => {
    await withSandbox(async (sb) => {
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
        const result = await rpcHandler(
            'exec.start',
            {
                cmd: ['true'],
                authSelection: profileSelection(sb, 'codex', profileId)
            },
            ctx('exec-empty')
        )
        assert.equal(result.ok, false)
        assert.match(result.error ?? '', /auth_reauth_required/)
        const unknown = await rpcHandler(
            'exec.start',
            {
                cmd: ['true'],
                authSelection: profileSelection(
                    sb,
                    'codex',
                    createObjectId('runtimeAuthProfile')
                )
            },
            ctx('exec-unknown')
        )
        assert.equal(unknown.ok, false)
        assert.match(unknown.error ?? '', /auth_profile_missing/)
    })
})

test('an execution holds the profile lock for its lifetime; same-profile work queues behind it', async () => {
    await withSandbox(async (sb) => {
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
        const manager = new RuntimeAuthManager(
            { daemonId: sb.daemonId, runtimeId: sb.runtimeId },
            {
                credentialFacts: async () => null,
                cliVersion: async () => null,
                fetch: async () => {
                    throw new Error('no vendor call')
                },
                now: Date.now,
                platform: 'linux',
                env: process.env
            }
        )
        const ready = barrier()
        let output = ''
        const running = rpcHandler(
            'exec.start',
            {
                cmd: [
                    process.execPath,
                    '-e',
                    "process.stdin.once('data', () => process.stdin.destroy()); process.stdout.write('exec-ready\\n')"
                ],
                env: { NODE_TEST_CONTEXT: '' },
                keepStdinOpen: true,
                authSelection: profileSelection(sb, 'codex', profileId)
            },
            {
                ...ctx('exec-long'),
                sendEvent: (kind, data) => {
                    if (kind === 'stdout') output += data
                    if (output.includes('exec-ready')) ready.open()
                }
            }
        )
        try {
            await within(ready.reached, 'exec ready and holding the profile')
            await assert.rejects(
                manager.executionContext('codex', profileId, 'probe', {
                    waitMs: 0
                }),
                (err: unknown) => err instanceof ProfileBusyError
            )
            await rpcHandler(
                'exec.input',
                { refId: 'exec-long', data: 'finish' },
                ctx('finish-long')
            )
            assert.equal((await within(running, 'exec completion')).ok, true)
            const after = await manager.executionContext(
                'codex',
                profileId,
                'probe',
                { waitMs: 0 }
            )
            await after.release()
        } finally {
            await rpcHandler(
                'exec.abort',
                { refId: 'exec-long' },
                ctx('cleanup-long')
            )
            await within(running, 'exec cleanup')
        }
    })
})

test('exec completion waits for auth cleanup before terminal publication, resume and drain release', async (t) => {
    await withSandbox(async (sb) => {
        t.after(() => rm(sb.base, { recursive: true, force: true }))
        const profileId = createObjectId('runtimeAuthProfile')
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
                    ctx('release-create')
                )
            ).ok,
            true
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
        const entered = barrier()
        const allowRelease = barrier()
        let acquire: RuntimeAuthManager['executionContext'] | undefined
        let releaseCount = 0
        let releaseTask: Promise<void> | undefined
        const executionContext = RuntimeAuthManager.prototype.executionContext
        t.after(() => {
            RuntimeAuthManager.prototype.executionContext = executionContext
        })
        RuntimeAuthManager.prototype.executionContext = async function (
            this: RuntimeAuthManager,
            ...args: Parameters<typeof executionContext>
        ) {
            const context = await executionContext.apply(this, args)
            if (args[2] !== 'exec:release-barrier') return context
            acquire = executionContext.bind(this)
            return {
                ...context,
                release: () => {
                    releaseCount++
                    entered.open()
                    releaseTask = (async () => {
                        await allowRelease.reached
                        await context.release()
                    })()
                    return releaseTask
                }
            }
        }
        let acknowledged = false
        let resumed = false
        let resume: ReturnType<typeof rpcHandler> | undefined
        const running = rpcHandler(
            'exec.start',
            {
                cmd: [process.execPath, '-e', ''],
                env: { NODE_TEST_CONTEXT: '' },
                authSelection: profileSelection(sb, 'codex', profileId)
            },
            ctx('release-barrier')
        ).then((result) => {
            acknowledged = true
            return result
        })
        try {
            await within(entered.reached, 'auth release entry')
            resume = rpcHandler(
                'exec.resume',
                {
                    originalRefId: 'release-barrier',
                    fromSeq: 0
                },
                ctx('release-resume')
            ).then((result) => {
                resumed = true
                return result
            })
            await new Promise<void>((resolve) => setImmediate(resolve))
            assert.equal(execStreams.get('release-barrier')?.status, 'running')
            assert.equal(readFinal('release-barrier'), null)
            assert.equal(acknowledged, false)
            assert.equal(resumed, false)
            assert.equal(daemonActivitySnapshot().activeExecs, 1)
            assert.ok(acquire)
            await assert.rejects(
                acquire('codex', profileId, 'probe', {
                    waitMs: 0
                }),
                ProfileBusyError
            )
            allowRelease.open()
            assert.equal((await within(running, 'start completion')).ok, true)
            assert.equal((await within(resume, 'resume completion')).ok, true)
            assert.equal(releaseCount, 1)
            assert.equal(daemonActivitySnapshot().activeExecs, 0)
            const after = await acquire(
                'codex',
                profileId,
                'probe',
                { waitMs: 0 }
            )
            await after.release()
        } finally {
            allowRelease.open()
            await rpcHandler(
                'exec.abort',
                { refId: 'release-barrier' },
                ctx('cleanup-release')
            )
            await within(
                Promise.allSettled([running, resume, releaseTask]),
                'release cleanup'
            )
        }
    })
})

for (const scenario of [
    'nonzero',
    'spawn-error',
    'cancel',
    'timeout',
    'publish-error',
    'subscriber-error',
    'release-error',
    'buffer-setup',
    'spawn-setup'
] as const) {
    test(`exec ${scenario} owns one terminal result after auth release`, async (t) => {
        await withSandbox(async (sb) => {
            t.after(() => rm(sb.base, { recursive: true, force: true }))
            const profileId = createObjectId('runtimeAuthProfile')
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
                        ctx(`create-${scenario}`)
                    )
                ).ok,
                true
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
            await writeFile(
                join(view, 'auth.json'),
                '{"auth_mode":"chatgpt"}',
                { mode: 0o600 }
            )
            const refId = `finish-${scenario}`
            const entered = barrier()
            const allowRelease = barrier()
            const registered = barrier()
            let cancel: (() => void) | undefined
            let releaseCount = 0
            let subscriberErrors = 0
            let actualRelease: (() => Promise<void>) | undefined
            let releaseTask: Promise<void> | undefined
            let acquire: RuntimeAuthManager['executionContext'] | undefined
            const executionContext =
                RuntimeAuthManager.prototype.executionContext
            t.after(() => {
                RuntimeAuthManager.prototype.executionContext = executionContext
            })
            RuntimeAuthManager.prototype.executionContext = async function (
                this: RuntimeAuthManager,
                ...args: Parameters<typeof executionContext>
            ) {
                const context = await executionContext.apply(this, args)
                if (args[2] !== `exec:${refId}`) return context
                acquire = executionContext.bind(this)
                actualRelease = context.release
                return {
                    ...context,
                    release: () => {
                        releaseCount++
                        entered.open()
                        releaseTask = (async () => {
                            await allowRelease.reached
                            if (scenario === 'release-error')
                                throw new Error('private-credential-fixture')
                            await context.release()
                        })()
                        return releaseTask
                    }
                }
            }
            if (scenario === 'buffer-setup')
                await writeFile(daemonPaths.execDir, 'not a directory')
            const cmd =
                scenario === 'spawn-error'
                    ? [join(sb.base, 'missing-command')]
                    : scenario === 'spawn-setup'
                      ? [null]
                      : [
                            process.execPath,
                            '-e',
                            scenario === 'nonzero'
                                ? 'process.exitCode = 7'
                                : scenario === 'publish-error'
                                  ? "process.stdin.on('data', () => process.stdout.write('output')); process.stdin.resume()"
                                  : scenario === 'subscriber-error'
                                    ? "process.stdout.write('output')"
                                    : scenario === 'cancel' ||
                                        scenario === 'timeout'
                                      ? 'setInterval(() => {}, 1000)'
                                      : ''
                        ]
            let acknowledged = false
            const running = rpcHandler(
                'exec.start',
                {
                    cmd,
                    env: { NODE_TEST_CONTEXT: '' },
                    keepStdinOpen: scenario === 'publish-error',
                    ...(scenario === 'timeout' ? { timeoutMs: 30 } : {}),
                    authSelection: profileSelection(sb, 'codex', profileId)
                },
                {
                    ...ctx(refId),
                    sendEvent: () => {
                        if (scenario === 'subscriber-error') {
                            subscriberErrors++
                            throw new Error('transport unavailable')
                        }
                    },
                    onCancel: (handler) => {
                        cancel = handler
                        registered.open()
                    }
                }
            ).then((result) => {
                acknowledged = true
                return result
            })
            try {
                if (scenario === 'cancel' || scenario === 'publish-error') {
                    await within(registered.reached, 'registered child')
                    if (scenario === 'cancel') cancel!()
                    else {
                        const events = join(
                            daemonPaths.execDir,
                            refId,
                            'events.ndjson'
                        )
                        await rm(events)
                        await mkdir(events)
                        assert.equal(
                            (
                                await rpcHandler(
                                    'exec.input',
                                    { refId, data: 'write' },
                                    ctx('publish-input')
                                )
                            ).ok,
                            true
                        )
                    }
                }
                await within(entered.reached, 'release entry')
                await new Promise<void>((resolve) => setImmediate(resolve))
                assert.equal(acknowledged, false)
                if (scenario === 'subscriber-error') {
                    assert.equal(subscriberErrors, 1)
                    assert.equal(execStreams.get(refId)?.subscribers.size, 0)
                }
                if (scenario !== 'buffer-setup')
                    assert.equal(execStreams.get(refId)?.status, 'running')
                assert.equal(readFinal(refId), null)
                if (scenario !== 'buffer-setup' && scenario !== 'spawn-setup')
                    assert.equal(daemonActivitySnapshot().activeExecs, 1)
                allowRelease.open()
                const result = await within(running, 'terminal ACK')
                assert.equal(releaseCount, 1)
                assert.equal(daemonActivitySnapshot().activeExecs, 0)
                assert.ok(acquire)
                if (scenario === 'release-error') {
                    assert.equal(result.ok, false)
                    assert.equal(result.error, 'auth_context_release_failed')
                    assert.ok(
                        !JSON.stringify(readFinal(refId)).includes(
                            'private-credential-fixture'
                        )
                    )
                    await assert.rejects(
                        acquire('codex', profileId, 'probe', {
                            waitMs: 0
                        }),
                        ProfileBusyError
                    )
                } else {
                    const after = await acquire(
                        'codex',
                        profileId,
                        'probe',
                        { waitMs: 0 }
                    )
                    await after.release()
                    if (
                        scenario === 'nonzero' ||
                        scenario === 'timeout' ||
                        scenario === 'subscriber-error'
                    ) {
                        assert.equal(result.ok, true)
                        assert.equal(
                            result.payload?.exitCode,
                            scenario === 'nonzero' ? 7 : 0
                        )
                    } else {
                        assert.equal(result.ok, false)
                        if (scenario === 'spawn-error') {
                            assert.match(result.error ?? '', /ENOENT/)
                            assert.equal(result.payload?.exitCode, -1)
                        } else if (scenario === 'publish-error')
                            assert.match(
                                result.error ?? '',
                                /buffer append failed/
                            )
                        else
                            assert.equal(
                                result.error,
                                scenario === 'cancel'
                                    ? 'cancelled'
                                    : `exec_${scenario.split('-')[0]}_setup_failed`
                            )
                    }
                }
                if (scenario !== 'buffer-setup')
                    assert.deepEqual(
                        readFinal(refId),
                        JSON.parse(JSON.stringify(result))
                    )
            } finally {
                allowRelease.open()
                await rpcHandler(
                    'exec.abort',
                    { refId },
                    ctx('failure-cleanup')
                )
                await within(
                    Promise.allSettled([running, releaseTask]),
                    'failure cleanup'
                )
                if (scenario === 'release-error') await actualRelease?.()
            }
        })
    })
}

test('model.inspect under a profile reads the view, not the native home', async () => {
    await withSandbox(async (sb) => {
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
        await writeFile(
            join(view, 'auth.json'),
            '{"auth_mode":"chatgpt","tokens":{"access_token":"a.b.c","refresh_token":"r"}}',
            { mode: 0o600 }
        )
        const native = await rpcHandler(
            'model.inspect',
            { framework: 'codex' },
            ctx('mi-native')
        )
        const scoped = await rpcHandler(
            'model.inspect',
            {
                framework: 'codex',
                authSelection: profileSelection(sb, 'codex', profileId)
            },
            ctx('mi-profile')
        )
        const facts = (r: typeof native) =>
            (
                r.payload as {
                    frameworks: Array<{
                        credentialFacts: { authFilePresent: boolean }
                    }>
                }
            ).frameworks[0].credentialFacts
        assert.equal(
            facts(native).authFilePresent,
            false,
            'native home has no auth.json'
        )
        assert.equal(
            facts(scoped).authFilePresent,
            true,
            'the profile view does'
        )
    })
})

// An api-key profile has no vendor sign-in: the key handed over at creation
// is the credential. It must reach the child as the vendor variable even
// though every ambient copy of that variable is stripped, and it must be
// the one thing a sign-out removes.
test('an api-key profile stores its key in the view and injects it as the vendor variable', async () => {
    await withSandbox(async (sb) => {
        process.env.OPENAI_API_KEY = 'ambient-daemon-key'
        const profileId = createObjectId('runtimeAuthProfile')
        const created = await rpcHandler(
            'auth.create',
            {
                framework: 'codex',
                runtimeId: sb.runtimeId,
                profileId,
                authMethod: 'api-key',
                apiKey: 'sk-profile-key-1234567890'
            },
            ctx('c')
        )
        assert.equal(created.ok, true, created.error)
        assert.equal(
            (created.payload as { generation: number }).generation,
            1,
            'a stored key counts as the first sign-in'
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
        const keyFile = join(view, 'api-key')
        assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
        assert.equal(
            (await readFile(keyFile, 'utf8')).trim(),
            'sk-profile-key-1234567890'
        )

        const listed = await rpcHandler(
            'auth.list',
            { framework: 'codex', runtimeId: sb.runtimeId, probe: true },
            ctx('l')
        )
        assert.equal(listed.ok, true, listed.error)
        const [report] = (
            listed.payload as {
                profiles: Array<{
                    authMethod: string
                    probe: { credentialFacts: { envApiKey: boolean } } | null
                }>
            }
        ).profiles
        assert.equal(report.authMethod, 'api-key')
        assert.equal(
            report.probe?.credentialFacts.envApiKey,
            true,
            'the view probe reports the stored key as its credential'
        )

        const out = join(sb.base, 'env.txt')
        const result = await rpcHandler(
            'exec.start',
            {
                cmd: ['sh', '-c', 'env > "$OUT"'],
                env: { OUT: out, OPENAI_API_KEY: 'from-agent-extras' },
                authSelection: profileSelection(sb, 'codex', profileId)
            },
            ctx('exec-key')
        )
        assert.equal(result.ok, true, result.error)
        const text = await readFile(out, 'utf8')
        assert.match(text, /^OPENAI_API_KEY=sk-profile-key-1234567890$/m)
        assert.match(text, new RegExp(`^CODEX_HOME=${view}$`, 'm'))

        const manager = new RuntimeAuthManager(
            { daemonId: sb.daemonId, runtimeId: sb.runtimeId },
            {
                credentialFacts: async () => null,
                cliVersion: async () => '0.153.4',
                fetch: async () => {
                    throw new Error('no vendor call expected')
                },
                now: Date.now,
                platform: 'linux',
                env: process.env
            }
        )
        await assert.rejects(
            manager.prepareLogin(
                'codex',
                profileId,
                createObjectId('runtimeAuthOperation')
            ),
            /auth_api_key_no_login/
        )

        const logout = await rpcHandler(
            'auth.logout',
            {
                framework: 'codex',
                runtimeId: sb.runtimeId,
                profileId,
                operationId: createObjectId('runtimeAuthOperation'),
                mode: 'sign-out'
            },
            ctx('lo')
        )
        assert.equal(logout.ok, true, logout.error)
        await assert.rejects(stat(keyFile), 'the key file is gone after sign-out')
        const refused = await rpcHandler(
            'exec.start',
            {
                cmd: ['true'],
                authSelection: profileSelection(sb, 'codex', profileId)
            },
            ctx('exec-after-logout')
        )
        assert.equal(refused.ok, false)
        assert.match(refused.error ?? '', /auth_reauth_required/)
        delete process.env.OPENAI_API_KEY
    })
})

// ADR-0029 §4 (B2): with the file exec switch on, a profile-bound exec runs
// detached through files, still holds the profile lease for its lifetime,
// records only the lease's path in its meta, and gives the lease back once
// its output is drained — the same contract as the pipe path, minus the
// pipes.
test(
    'a profile-bound exec on the file path holds the lease, records its path and releases it',
    { skip: process.platform === 'win32' },
    async () => {
        await withSandbox(async (sb) => {
            const prior = process.env.MF_DAEMON_EXEC_FILES
            process.env.MF_DAEMON_EXEC_FILES = '1'
            const profileId = createObjectId('runtimeAuthProfile')
            try {
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
                const profileDir = join(
                    sb.configDir,
                    'runtime-auth',
                    sb.daemonId,
                    sb.runtimeId,
                    'profiles',
                    profileId
                )
                await writeFile(
                    join(profileDir, 'view', 'auth.json'),
                    '{"auth_mode":"chatgpt"}',
                    { mode: 0o600 }
                )
                const manager = new RuntimeAuthManager(
                    { daemonId: sb.daemonId, runtimeId: sb.runtimeId },
                    {
                        credentialFacts: async () => null,
                        cliVersion: async () => null,
                        fetch: async () => {
                            throw new Error('no vendor call')
                        },
                        now: Date.now,
                        platform: 'linux',
                        env: process.env
                    }
                )
                const ready = barrier()
                let output = ''
                const refId = 'exec-files-lease'
                const running = rpcHandler(
                    'exec.start',
                    {
                        cmd: ['/bin/sh', '-c', 'echo exec-ready; sleep 30'],
                        env: { SECRET_VENDOR_KEY: 'sk-never-on-disk' },
                        authSelection: profileSelection(sb, 'codex', profileId)
                    },
                    {
                        ...ctx(refId),
                        sendEvent: (kind, data) => {
                            if (kind === 'stdout') output += data
                            if (output.includes('exec-ready')) ready.open()
                        }
                    }
                )
                await within(ready.reached, 'file exec ready under the profile')
                const meta = readMeta(refId) as unknown as {
                    format: number
                    auth?: { lockDir: string; label: string }
                    payload: Record<string, unknown>
                }
                assert.equal(meta.format, 2, 'the exec went through files')
                assert.deepEqual(meta.auth, {
                    lockDir: join(profileDir, 'lock'),
                    label: `exec:${refId}`
                })
                assert.equal('env' in meta.payload, false)
                assert.ok(
                    !(
                        await readFile(
                            join(daemonPaths.execDir, refId, 'meta.json'),
                            'utf8'
                        )
                    ).includes('sk-never-on-disk')
                )
                await assert.rejects(
                    manager.executionContext('codex', profileId, 'probe', {
                        waitMs: 0
                    }),
                    (err: unknown) => err instanceof ProfileBusyError,
                    'the lease is held while the exec runs'
                )
                assert.equal(daemonActivitySnapshot().activeExecs, 1)
                await rpcHandler('exec.abort', { refId }, ctx('abort-files'))
                const result = await within(running, 'file exec completion')
                assert.equal(result.error, 'cancelled')
                assert.deepEqual(readFinal(refId), {
                    ok: false,
                    payload: result.payload,
                    error: 'cancelled'
                })
                const after = await manager.executionContext(
                    'codex',
                    profileId,
                    'probe',
                    { waitMs: 0 }
                )
                await after.release()
                assert.equal(daemonActivitySnapshot().activeExecs, 0)
            } finally {
                if (prior === undefined) delete process.env.MF_DAEMON_EXEC_FILES
                else process.env.MF_DAEMON_EXEC_FILES = prior
            }
        })
    }
)
