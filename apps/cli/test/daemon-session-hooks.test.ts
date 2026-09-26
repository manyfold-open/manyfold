import test from 'node:test'
import assert from 'node:assert/strict'
import {
    mkdtemp,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    writeFile
} from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    AGY_HOOK_BLOCK,
    buildAgySessionHookScript,
    buildPiSessionHookExtension,
    buildSessionHookScript,
    codexHooksDisabledInConfig,
    hookReportFromInput,
    installSessionHooks,
    mergeAgyNamedHooks,
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
                ['codex', false, false],
                ['pi', false, false],
                ['antigravity-cli', false, false]
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
            { framework: 'codex', action: 'removed' },
            { framework: 'pi', action: 'absent' },
            { framework: 'antigravity-cli', action: 'absent' }
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
            ['absent', 'absent', 'absent', 'absent']
        )
    })
})

// pi takes its hook as an extension it loads by itself from the agent dir:
// one marked file, no settings to merge, and a user's file of the same name
// is never replaced.
test('the pi hook is one marked extension file that pi loads on its own', async () => {
    await withHome(async (home) => {
        const pi = sessionHookTargets(home).find((t) => t.framework === 'pi')!
        assert.equal(pi.kind, 'extension')
        assert.equal(
            pi.scriptPath,
            join(home, '.pi', 'agent', 'extensions', 'mf-session.ts')
        )
        const changes = await installSessionHooks({
            detected: [{ framework: 'pi', version: '0.87.1', path: '/bin/pi' }],
            home,
            invocation: ['/opt/node', "/opt/mf's/index.js"]
        })
        assert.deepEqual(changes, [{ framework: 'pi', action: 'installed' }])
        const extension = await readFile(pi.scriptPath, 'utf8')
        assert.equal(scriptVersion(extension), MF_SESSION_HOOK_VERSION)
        assert.match(extension, /if \(!process\.env\.MF_TERMINAL_ID\) return/)
        assert.match(extension, /'daemon', 'hooks', 'report', 'pi'/)
        // `mf doctor` reads the callback back out of it, quotes and all.
        assert.deepEqual(sessionHookInvocation(extension), [
            '/opt/node',
            "/opt/mf's/index.js"
        ])
        const status = await sessionHooksStatus({ home, consent: 'enabled' })
        const piStatus = status.frameworks.find((f) => f.framework === 'pi')!
        assert.deepEqual([piStatus.installed, piStatus.current], [true, true])

        assert.deepEqual(
            (await uninstallSessionHooks({ home })).find(
                (c) => c.framework === 'pi'
            ),
            { framework: 'pi', action: 'removed' }
        )
        await assert.rejects(stat(pi.scriptPath))

        await writeFile(pi.scriptPath, 'export default () => {}\n')
        const refused = await installSessionHooks({
            detected: 'all',
            home,
            invocation: ['/opt/mf']
        })
        assert.match(
            refused.find((c) => c.framework === 'pi')?.error ?? '',
            /not a Manyfold hook/
        )
        assert.equal(
            await readFile(pi.scriptPath, 'utf8'),
            'export default () => {}\n'
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

// The extension is generated source no typecheck sees: run it the way pi
// does, handing its default export the event bus, and read what it reported.
test('the pi extension reports sessions only inside a Manyfold terminal', async () => {
    await withHome(async (home) => {
        const sink = join(home, 'reports.jsonl')
        const recorder = join(home, 'record.mjs')
        await writeFile(
            recorder,
            [
                "import { appendFileSync } from 'node:fs'",
                "let input = ''",
                "process.stdin.on('data', (chunk) => (input += chunk))",
                "process.stdin.on('end', () =>",
                `    appendFileSync(${JSON.stringify(sink)}, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(input) }) + '\\n')`,
                ')'
            ].join('\n')
        )
        const file = join(home, 'mf-session.ts')
        await writeFile(
            file,
            buildPiSessionHookExtension([process.execPath, recorder])
        )
        const { default: register } = (await import(
            pathToFileURL(file).href
        )) as { default: (pi: unknown) => void }
        type Handler = (event: unknown, ctx: unknown) => void
        const handlers = new Map<string, Handler>()
        const bus = {
            on: (name: string, handler: Handler) => handlers.set(name, handler)
        }
        const ctx = (entries: unknown[]) => ({
            sessionManager: {
                getSessionId: () => 'sess-1',
                getCwd: () => '/work',
                getEntries: () => entries
            }
        })

        const terminalId = process.env.MF_TERMINAL_ID
        try {
            delete process.env.MF_TERMINAL_ID
            register(bus)
            assert.equal(handlers.size, 0)
            process.env.MF_TERMINAL_ID = 'tms_test'
            register(bus)
        } finally {
            if (terminalId === undefined) delete process.env.MF_TERMINAL_ID
            else process.env.MF_TERMINAL_ID = terminalId
        }
        const start = handlers.get('session_start')!
        const shutdown = handlers.get('session_shutdown')!
        start({ reason: 'startup' }, ctx([]))
        // `pi --continue` starts with history: that is a resume.
        start({ reason: 'startup' }, ctx([{ type: 'message' }]))
        start({ reason: 'new' }, ctx([]))
        shutdown({ reason: 'reload' }, ctx([]))
        shutdown({ reason: 'quit' }, ctx([]))

        const lines = async (): Promise<string[]> =>
            (await readFile(sink, 'utf8').catch(() => ''))
                .split('\n')
                .filter(Boolean)
        for (let i = 0; i < 100 && (await lines()).length < 4; i++)
            await new Promise((r) => setTimeout(r, 50))
        // A reload is the same session: nothing more may arrive.
        await new Promise((r) => setTimeout(r, 300))
        const reports = (await lines()).map(
            (line) => JSON.parse(line) as { args: string[]; input: unknown }
        )
        for (const report of reports)
            assert.deepEqual(report.args, ['daemon', 'hooks', 'report', 'pi'])
        const filed = reports
            .map((report) => hookReportFromInput('pi', report.input))
            .map(
                (body) =>
                    `${body?.event}:${body?.source}:${body?.sessionRef}:${body?.cwd}`
            )
            .sort()
        assert.deepEqual(filed, [
            'end:other:sess-1:/work',
            'start:clear:sess-1:/work',
            'start:resume:sess-1:/work',
            'start:startup:sess-1:/work'
        ])
    })
})

const AGY_CONVERSATION = '6bce3054-1614-4b63-b9b5-9590cdfc8458'

test('the agy hook is a block of its own in hooks.json; other blocks stay', async () => {
    await withHome(async (home) => {
        const agy = sessionHookTargets(home).find(
            (t) => t.framework === 'antigravity-cli'
        )!
        assert.equal(agy.kind, 'named-hooks')
        assert.equal(
            agy.settingsPath,
            join(home, '.gemini', 'config', 'hooks.json')
        )
        await mkdir(join(home, '.gemini', 'config'), { recursive: true })
        // herdr keeps a block of its own there.
        const herdr = {
            herdr: { Stop: [{ type: 'command', command: 'herdr notify' }] }
        }
        await writeFile(agy.settingsPath, JSON.stringify(herdr))
        const changes = await installSessionHooks({
            detected: [
                {
                    framework: 'antigravity-cli',
                    version: '1.2.11',
                    path: '/bin/agy'
                }
            ],
            home,
            invocation: ['/opt/mf']
        })
        assert.deepEqual(changes, [
            { framework: 'antigravity-cli', action: 'installed' }
        ])
        const written = JSON.parse(await readFile(agy.settingsPath, 'utf8'))
        assert.deepEqual(written.herdr, herdr.herdr)
        assert.deepEqual(Object.keys(written[AGY_HOOK_BLOCK]), [
            'SessionStart',
            'PreInvocation'
        ])
        assert.equal(
            written[AGY_HOOK_BLOCK].PreInvocation[0].command,
            `'${agy.scriptPath}' PreInvocation`
        )
        const script = await readFile(agy.scriptPath, 'utf8')
        assert.equal(scriptVersion(script), MF_SESSION_HOOK_VERSION)
        assert.deepEqual(sessionHookInvocation(script), ['/opt/mf'])
        const status = await sessionHooksStatus({ home, consent: 'enabled' })
        const agyStatus = status.frameworks.find(
            (f) => f.framework === 'antigravity-cli'
        )!
        assert.deepEqual([agyStatus.installed, agyStatus.current], [true, true])
        assert.equal(
            mergeAgyNamedHooks(
                await readFile(agy.settingsPath, 'utf8'),
                agy,
                'install'
            ).changed,
            false
        )

        const removed = await uninstallSessionHooks({ home })
        assert.deepEqual(
            removed.find((c) => c.framework === 'antigravity-cli'),
            { framework: 'antigravity-cli', action: 'removed' }
        )
        assert.deepEqual(
            JSON.parse(await readFile(agy.settingsPath, 'utf8')),
            herdr
        )
        await assert.rejects(stat(agy.scriptPath))

        await writeFile(agy.settingsPath, '{ not json')
        const refused = await installSessionHooks({
            detected: 'all',
            home,
            invocation: ['/opt/mf']
        })
        assert.match(
            refused.find((c) => c.framework === 'antigravity-cli')?.error ?? '',
            /not valid JSON/
        )
        assert.equal(await readFile(agy.settingsPath, 'utf8'), '{ not json')
    })
})

test('agy’s hook input maps to a start or an end by the event its hook names', () => {
    const base = {
        conversationId: AGY_CONVERSATION,
        transcriptPath:
            '/h/brain/x/.system_generated/logs/transcript_full.jsonl',
        workspacePaths: ['/home/me/ws']
    }
    const lines = (n: number) => (): number => n
    assert.deepEqual(
        hookReportFromInput(
            'antigravity-cli',
            { ...base, initialNumSteps: 1, invocationNum: 0 },
            'PreInvocation',
            lines(0)
        ),
        {
            framework: 'antigravity-cli',
            event: 'start',
            source: 'startup',
            sessionRef: AGY_CONVERSATION,
            cwd: '/home/me/ws'
        }
    )
    assert.equal(
        hookReportFromInput(
            'antigravity-cli',
            { ...base, initialNumSteps: 7 },
            'PreInvocation',
            lines(0)
        )?.source,
        'resume'
    )
    // A fresh TUI conversation starts once its first prompt is logged; a
    // resumed one's log already holds a whole turn.
    assert.equal(
        hookReportFromInput('antigravity-cli', base, 'SessionStart', lines(1))
            ?.source,
        'startup'
    )
    assert.equal(
        hookReportFromInput('antigravity-cli', base, 'SessionStart', lines(2))
            ?.source,
        'resume'
    )
    assert.deepEqual(
        hookReportFromInput(
            'antigravity-cli',
            { conversationId: AGY_CONVERSATION },
            'SessionEnd'
        ),
        {
            framework: 'antigravity-cli',
            event: 'end',
            source: 'other',
            sessionRef: AGY_CONVERSATION
        }
    )
    assert.equal(
        hookReportFromInput('antigravity-cli', base, 'PostToolUse'),
        null
    )
    assert.equal(
        hookReportFromInput(
            'antigravity-cli',
            { conversationId: 'latest' },
            'SessionStart'
        ),
        null
    )
})

// The hook for real: a stand-in `agy` (node under that name, so the process
// is called agy as the real one is) runs it the way agy 1.2.11 does, through
// `sh -c`, and the Manyfold callback is a script that logs what it was given.
test('the agy hook reports a conversation once and its end when agy exits', async () => {
    await withHome(async (home) => {
        const bin = join(home, 'bin')
        await mkdir(bin, { recursive: true })
        await symlink(process.execPath, join(bin, 'agy'))
        const log = join(home, 'mf.log')
        const fakeMf = join(home, 'fake-mf')
        await writeFile(
            fakeMf,
            `#!/bin/sh\nprintf '%s ' "$@" "lines=$MF_AGY_LOG_LINES" >> '${log}'\ncat >> '${log}'\nprintf '\\n' >> '${log}'\n`,
            { mode: 0o755 }
        )
        const script = join(home, 'mf-session.sh')
        await writeFile(script, buildAgySessionHookScript([fakeMf]), {
            mode: 0o755
        })
        const runAgy = (terminalId: string): string =>
            execFileSync(
                join(bin, 'agy'),
                [
                    '-e',
                    `const { execFileSync } = require('node:child_process')
const hook = (event) => execFileSync('sh', ['-c', ${JSON.stringify(`'${script}' "$0"`)}, event], {
    input: JSON.stringify({ conversationId: '${AGY_CONVERSATION}', initialNumSteps: 1, workspacePaths: ['/ws'] })
}).toString()
process.stdout.write(hook('SessionStart') + hook('PreInvocation'))`
                ],
                {
                    env: {
                        PATH: '/usr/bin:/bin',
                        HOME: home,
                        TMPDIR: home,
                        MF_TERMINAL_ID: terminalId,
                        ANTIGRAVITY_CONVERSATION_ID: AGY_CONVERSATION
                    }
                }
            ).toString()

        // The conversation's log holds a whole turn when agy runs the hook.
        const logs = join(
            home,
            '.gemini/antigravity-cli/brain',
            AGY_CONVERSATION,
            '.system_generated/logs'
        )
        await mkdir(logs, { recursive: true })
        await writeFile(join(logs, 'transcript_full.jsonl'), '{}\n{}\n')

        // Outside a Manyfold terminal it only answers agy.
        assert.equal(runAgy(''), '{}{}')
        assert.equal(await readFile(log, 'utf8').catch(() => ''), '')

        assert.equal(runAgy('trm_1'), '{}{}')
        const deadline = Date.now() + 8000
        let lines: string[] = []
        while (Date.now() < deadline) {
            lines = (await readFile(log, 'utf8').catch(() => ''))
                .split('\n')
                .filter(Boolean)
            // The fake callback writes its arguments before its stdin.
            if (lines.some((line) => line.includes('SessionEnd {"'))) break
            await new Promise((resolve) => setTimeout(resolve, 200))
        }
        assert.equal(lines.length, 2, lines.join('\n'))
        assert.match(
            lines[0],
            /^daemon hooks report antigravity-cli SessionStart lines=2 \{"conversationId":"6bce3054/
        )
        assert.match(
            lines[1],
            new RegExp(
                `^daemon hooks report antigravity-cli SessionEnd lines=\\d* \\{"conversationId":"${AGY_CONVERSATION}"\\}$`
            )
        )
        // The waiter leaves nothing behind for the next agy in the terminal.
        const state = (await readdir(home)).find((name) =>
            name.startsWith('mf-agy-session-')
        )!
        assert.deepEqual(await readdir(join(home, state)), [])
    })
})

test('an agy session start reads how far the conversation’s log already goes', async () => {
    await withHome(async (home) => {
        const log = join(home, 'transcript_full.jsonl')
        const start = () =>
            hookReportFromInput(
                'antigravity-cli',
                { conversationId: AGY_CONVERSATION, transcriptPath: log },
                'SessionStart'
            )?.source
        assert.equal(start(), 'startup', 'no log yet')
        await writeFile(log, '{"type":"USER_INPUT"}\n')
        assert.equal(start(), 'startup', 'only the opening prompt')
        await writeFile(
            log,
            '{"type":"USER_INPUT"}\n{"type":"PLANNER_RESPONSE"}\n'
        )
        assert.equal(start(), 'resume')
        // The count the hook took while agy waited beats a later look.
        process.env.MF_AGY_LOG_LINES = '1'
        try {
            assert.equal(start(), 'startup')
        } finally {
            delete process.env.MF_AGY_LOG_LINES
        }
    })
})
