import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    buildSessionHookScript,
    codexHooksDisabledInConfig,
    hookReportFromInput,
    installSessionHooks,
    mergeSessionHookSettings,
    MF_SESSION_HOOK_VERSION,
    resolveMfInvocation,
    scriptVersion,
    sendSessionHookReport,
    sessionHookInvocation,
    sessionHookTargets,
    sessionHooksStatus,
    sessionHooksWantedByDefault,
    settingsHaveSessionHooks,
    uninstallSessionHooks
} from '../src/daemon/session-hooks'

const withHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'mf-session-hooks-'))
    try {
        await fn(home)
    } finally {
        await rm(home, { recursive: true, force: true })
    }
}

const DETECTED = [
    {
        framework: 'claude-code' as const,
        version: '2.1.0',
        path: '/bin/claude'
    },
    { framework: 'codex' as const, version: '0.9.0', path: '/bin/codex' },
    { framework: 'gemini-cli' as const, version: null, path: '/bin/gemini' }
]

test('the hook script acts only inside a Manyfold terminal and calls this CLI back', () => {
    const script = buildSessionHookScript(['/opt/mf/bin/mf'])
    assert.match(script, /^#!\/bin\/sh\n/)
    assert.equal(scriptVersion(script), MF_SESSION_HOOK_VERSION)
    assert.match(script, /\[ -n "\$\{MF_TERMINAL_ID:-\}" \] \|\| exit 0/)
    assert.match(script, /'\/opt\/mf\/bin\/mf' daemon hooks report "\$1"/)
    // Backgrounded, silenced: SessionStart stdout would reach the model.
    assert.match(script, />\/dev\/null 2>&1 & \)/)
    assert.equal(scriptVersion('#!/bin/sh\necho hi\n'), null)
})

test('the callback names the standalone binary or the interpreter running a checkout', () => {
    assert.deepEqual(
        resolveMfInvocation({
            standalone: true,
            execPath: '/usr/local/bin/mf'
        }),
        ['/usr/local/bin/mf']
    )
    assert.deepEqual(
        resolveMfInvocation({
            standalone: false,
            execPath: '/usr/bin/node',
            entry: '/repo/apps/cli/dist/index.js'
        }),
        ['/usr/bin/node', '/repo/apps/cli/dist/index.js']
    )
    assert.deepEqual(
        resolveMfInvocation({
            standalone: false,
            execPath: '/usr/bin/node',
            entry: '/repo/apps/cli/src/index.ts'
        }),
        ['/usr/bin/node', '--import', 'tsx', '/repo/apps/cli/src/index.ts']
    )
    assert.deepEqual(
        resolveMfInvocation({
            standalone: false,
            execPath: '/usr/bin/node',
            entry: undefined
        }),
        ['mf']
    )
})

test('the callback reads back out of an installed script', () => {
    for (const invocation of [
        ['/usr/local/bin/mf'],
        ['/usr/bin/node', '--import', 'tsx', '/repo/apps/cli/src/index.ts'],
        ["/Users/o'brien/My Tools/mf"],
        ['mf']
    ])
        assert.deepEqual(
            sessionHookInvocation(buildSessionHookScript(invocation)),
            invocation
        )
    assert.equal(sessionHookInvocation('#!/bin/sh\necho hi\n'), null)
})

test('the settings merge adds one managed group per event and keeps everything else', () => {
    const [claude] = sessionHookTargets('/home/me')
    const user = {
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
            SessionStart: [
                {
                    matcher: 'startup',
                    hooks: [{ type: 'command', command: 'echo mine' }]
                }
            ],
            PreToolUse: [{ hooks: [{ type: 'command', command: 'lint' }] }]
        }
    }
    const installed = mergeSessionHookSettings(
        JSON.stringify(user),
        claude,
        'install'
    )
    assert.equal(installed.changed, true)
    const parsed = JSON.parse(installed.next!) as {
        permissions: typeof user.permissions
        hooks: Record<
            string,
            Array<{ hooks: Array<{ command: string; timeout?: number }> }>
        >
    }
    assert.deepEqual(parsed.permissions, user.permissions)
    assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'lint')
    assert.equal(parsed.hooks.SessionStart.length, 2)
    assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'echo mine')
    assert.equal(
        parsed.hooks.SessionStart[1].hooks[0].command,
        `'/home/me/.claude/hooks/mf-session.sh' claude-code`
    )
    assert.equal(parsed.hooks.SessionStart[1].hooks[0].timeout, 5)
    assert.equal(parsed.hooks.SessionEnd.length, 1)
    assert.equal(settingsHaveSessionHooks(installed.next, claude), true)

    // A second install is a no-op; an older managed group is replaced, not
    // duplicated.
    const again = mergeSessionHookSettings(installed.next, claude, 'install')
    assert.equal(again.changed, false)
    const stale = installed.next!.replace('"timeout": 5', '"timeout": 2')
    const refreshed = mergeSessionHookSettings(stale, claude, 'install')
    assert.equal(refreshed.changed, true)
    assert.equal(
        (JSON.parse(refreshed.next!) as typeof parsed).hooks.SessionStart
            .length,
        2
    )

    // Uninstall removes only the managed groups and prunes emptied keys.
    const removed = mergeSessionHookSettings(
        installed.next,
        claude,
        'uninstall'
    )
    assert.equal(removed.changed, true)
    const after = JSON.parse(removed.next!) as typeof parsed
    assert.deepEqual(after.permissions, user.permissions)
    assert.equal(after.hooks.SessionStart.length, 1)
    assert.equal('SessionEnd' in after.hooks, false)
    assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'lint')
    const bare = mergeSessionHookSettings(
        JSON.stringify({
            hooks: {
                SessionEnd: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: `'/home/me/.claude/hooks/mf-session.sh' claude-code`
                            }
                        ]
                    }
                ]
            }
        }),
        claude,
        'uninstall'
    )
    assert.deepEqual(JSON.parse(bare.next!), {})
})

test('an unparseable settings file is reported, never rewritten', () => {
    const [claude] = sessionHookTargets('/home/me')
    assert.deepEqual(mergeSessionHookSettings('{ nope', claude, 'install'), {
        next: null,
        changed: false,
        error: 'not valid JSON'
    })
    assert.equal(
        mergeSessionHookSettings('[1,2]', claude, 'install').error,
        'not a JSON object'
    )
    const empty = mergeSessionHookSettings(null, claude, 'uninstall')
    assert.equal(empty.changed, false)
})

test('codex hooks count as off only when [features] says so', () => {
    assert.equal(codexHooksDisabledInConfig('model = "o3"\n'), false)
    assert.equal(
        codexHooksDisabledInConfig('[features]\nhooks = false\n'),
        true
    )
    assert.equal(
        codexHooksDisabledInConfig('[features]\ncodex_hooks = false\n'),
        true
    )
    assert.equal(
        codexHooksDisabledInConfig(
            '[other]\nhooks = false\n[features]\nhooks = true\n'
        ),
        false
    )
})

test('install writes the script and settings for detected frameworks only, and uninstall takes only ours', async () => {
    await withHome(async (home) => {
        const changes = await installSessionHooks({
            detected: DETECTED.filter((f) => f.framework !== 'codex'),
            home,
            invocation: ['/opt/mf']
        })
        assert.deepEqual(changes, [
            { framework: 'claude-code', action: 'installed' }
        ])
        const [claude, codex] = sessionHookTargets(home)
        const script = await readFile(claude.scriptPath, 'utf8')
        assert.equal(scriptVersion(script), MF_SESSION_HOOK_VERSION)
        assert.equal((await stat(claude.scriptPath)).mode & 0o111, 0o111)
        assert.equal(
            settingsHaveSessionHooks(
                await readFile(claude.settingsPath, 'utf8'),
                claude
            ),
            true
        )
        await assert.rejects(stat(codex.scriptPath))

        const status = await sessionHooksStatus({ home, consent: 'enabled' })
        assert.equal(status.consent, 'enabled')
        assert.deepEqual(
            status.frameworks.map((f) => [f.framework, f.installed, f.current]),
            [
                ['claude-code', true, true],
                ['codex', false, false]
            ]
        )

        // Second pass: nothing changes.
        assert.deepEqual(
            await installSessionHooks({
                detected: DETECTED,
                home,
                invocation: ['/opt/mf']
            }),
            [
                { framework: 'claude-code', action: 'unchanged' },
                { framework: 'codex', action: 'installed' }
            ]
        )
        // A user's own hooks.json content survives the codex install.
        await writeFile(
            codex.settingsPath,
            JSON.stringify({
                hooks: {
                    SessionStart: [
                        { hooks: [{ type: 'command', command: 'mine' }] }
                    ]
                }
            })
        )
        await installSessionHooks({
            detected: DETECTED,
            home,
            invocation: ['/opt/mf']
        })
        const codexSettings = JSON.parse(
            await readFile(codex.settingsPath, 'utf8')
        ) as { hooks: { SessionStart: unknown[] } }
        assert.equal(codexSettings.hooks.SessionStart.length, 2)
        const withNote = await sessionHooksStatus({ home, consent: null })
        assert.match(withNote.frameworks[1].note ?? '', /\/hooks/)

        // A foreign script at our path is not ours to delete.
        await mkdir(join(home, '.claude', 'hooks'), { recursive: true })
        await writeFile(claude.scriptPath, '#!/bin/sh\necho user script\n')
        const removed = await uninstallSessionHooks({ home })
        assert.deepEqual(removed, [
            { framework: 'claude-code', action: 'removed' },
            { framework: 'codex', action: 'removed' }
        ])
        assert.equal(
            await readFile(claude.scriptPath, 'utf8'),
            '#!/bin/sh\necho user script\n'
        )
        await assert.rejects(stat(codex.scriptPath))
        assert.equal(
            settingsHaveSessionHooks(
                await readFile(claude.settingsPath, 'utf8'),
                claude
            ),
            false
        )
        assert.equal(
            (
                JSON.parse(await readFile(codex.settingsPath, 'utf8')) as {
                    hooks: { SessionStart: unknown[] }
                }
            ).hooks.SessionStart.length,
            1
        )
        assert.deepEqual(
            (await uninstallSessionHooks({ home })).map((c) => c.action),
            ['absent', 'absent']
        )
    })
})

test('a sprite runner installs by default; a self-owned profile waits for consent', () => {
    assert.equal(sessionHooksWantedByDefault('spriterunner'), true)
    assert.equal(sessionHooksWantedByDefault('default'), false)
})

test('the hook input maps to the report the API takes', () => {
    assert.deepEqual(
        hookReportFromInput('claude-code', {
            session_id: 'abc-123',
            transcript_path: '/x.jsonl',
            cwd: '/home/me/p',
            hook_event_name: 'SessionStart',
            source: 'resume'
        }),
        {
            framework: 'claude-code',
            event: 'start',
            source: 'resume',
            sessionRef: 'abc-123',
            cwd: '/home/me/p'
        }
    )
    assert.deepEqual(
        hookReportFromInput('codex', {
            session_id: 'thr_1',
            hook_event_name: 'SessionEnd',
            reason: 'other'
        }),
        {
            framework: 'codex',
            event: 'end',
            source: 'other',
            sessionRef: 'thr_1'
        }
    )
    assert.equal(
        hookReportFromInput('claude-code', {
            session_id: 'abc',
            hook_event_name: 'SessionStart',
            source: 'teleport'
        })?.source,
        'other'
    )
    assert.equal(
        hookReportFromInput('claude-code', {
            session_id: 'abc',
            hook_event_name: 'PreToolUse'
        }),
        null
    )
    assert.equal(hookReportFromInput('claude-code', 'nope'), null)
})

test('the report is one POST with the terminal token and never throws', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (
        url: string | URL | Request,
        init?: RequestInit
    ) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({ data: { outcome: 'acquired' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    }) as typeof fetch
    const body = {
        framework: 'claude-code' as const,
        event: 'start' as const,
        source: 'startup' as const,
        sessionRef: 'abc'
    }
    const ok = await sendSessionHookReport({
        apiUrl: 'https://api.test/api',
        token: 'mfr_t',
        body,
        fetchImpl
    })
    assert.deepEqual(ok, {
        sent: true,
        status: 200,
        outcome: 'acquired',
        error: null
    })
    assert.equal(calls[0].url, 'https://api.test/api/terminal/session-hooks')
    assert.equal(
        new Headers(calls[0].init.headers).get('authorization'),
        'Bearer mfr_t'
    )
    assert.equal(calls[0].init.body, JSON.stringify(body))

    const refused = await sendSessionHookReport({
        apiUrl: 'https://api.test/api',
        token: 'mfr_t',
        body,
        fetchImpl: (async () =>
            new Response('{"code":"terminal_token_required"}', {
                status: 403
            })) as typeof fetch
    })
    assert.equal(refused.sent, false)
    assert.equal(refused.status, 403)
    const down = await sendSessionHookReport({
        apiUrl: 'https://api.test/api',
        token: 'mfr_t',
        body,
        fetchImpl: (async () => {
            throw new Error('ECONNREFUSED')
        }) as typeof fetch
    })
    assert.deepEqual(down, {
        sent: false,
        status: null,
        outcome: null,
        error: 'ECONNREFUSED'
    })
})
