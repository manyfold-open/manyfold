import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpException } from '@nestjs/common'
import {
    CHAT_SESSION_HELD_BY_TERMINAL_CODE,
    CHAT_SESSION_TURN_IN_FLIGHT_CODE,
    DAEMON_FEATURE_HERDR_PI,
    DAEMON_FEATURE_HERDR_TERMINAL,
    DAEMON_FEATURE_PTY_COMMAND,
    HERDR_LAUNCH_FAILED_CODE,
    HERDR_NOT_RUNNING_CODE,
    HERDR_UNAVAILABLE_CODE
} from '@manyfold/shared'
import { DaemonRpcResponseError } from '../src/modules/daemon/daemon-registry.service'
import { TerminalHerdrService } from '../src/modules/terminal/terminal-herdr.service'

// Handing a session to herdr (ADR-0031): the gates, the hold taken before
// anything runs, and the hold given back when herdr refuses.

const AGENT: Record<string, unknown> = {
    id: 'agt-1',
    userId: 'u1',
    name: 'Reviewer',
    status: 'running',
    runtime: 'daemon',
    daemonId: 'dh-1',
    hostId: null,
    runtimeId: 'rt-1',
    framework: 'claude-code',
    workspacePath: '/home/me/ws',
    mountPath: null,
    extras: {}
}

const HOST: Record<string, unknown> = {
    id: 'dh-1',
    clientFeatures: [DAEMON_FEATURE_PTY_COMMAND, DAEMON_FEATURE_HERDR_TERMINAL]
}

const SESSION: Record<string, unknown> = {
    id: 'cs-1',
    agentId: 'agt-1',
    title: 'Fix the login bug',
    holderTerminalId: null,
    holderClient: null
}

const codeOf = (err: unknown): string | undefined =>
    err instanceof HttpException
        ? (err.getResponse() as { code?: string }).code
        : undefined

const harness = (
    overrides: {
        agent?: Record<string, unknown>
        host?: Record<string, unknown> | null
        online?: boolean
        session?: Record<string, unknown> | null
        resolve?: Record<string, unknown>
        acquire?: string
        open?: () => Promise<Record<string, unknown>>
        preparePiView?: (
            daemonId: string,
            env: Record<string, string>
        ) => Promise<string>
        // The sprites arm: the sandbox row and what resolving its runner
        // gives; absent, the service was built without those services.
        sandbox?: Record<string, unknown> | null
        runner?: { host: Record<string, unknown> | null; availability: string }
        row?: Record<string, unknown>
    } = {}
) => {
    const created: Array<Record<string, unknown>> = []
    const resolves: Array<Record<string, unknown>> = []
    const handles: Array<[string, string]> = []
    const tokens: Array<[string, string]> = []
    const acquires: Array<Record<string, unknown>> = []
    const finished: Array<[string, string]> = []
    const opens: Array<Record<string, unknown>> = []
    const focuses: Array<[string, string]> = []
    const prepares: Array<[string, Record<string, string>]> = []
    const agent = { ...AGENT, ...overrides.agent }
    const host = overrides.host === null ? null : { ...HOST, ...overrides.host }
    const session =
        overrides.session === null ? null : { ...SESSION, ...overrides.session }
    const service = new TerminalHerdrService(
        { listForUser: async () => [{ agent }] } as never,
        {
            findById: async () => host,
            isOnline: () => overrides.online ?? true
        } as never,
        { getSession: async () => session } as never,
        {
            resolve: async (args: Record<string, unknown>) => {
                resolves.push(args)
                return (
                    overrides.resolve ?? {
                        resume: {
                            command: ['claude', '--resume', 'ref-1'],
                            env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' }
                        },
                        outcome: 'applied',
                        ref: 'ref-1'
                    }
                )
            }
        } as never,
        {
            create: async (input: Record<string, unknown>) => {
                created.push(input)
                return { id: 'tms_new', ...input }
            },
            setHandle: async (id: string, handle: string) => {
                handles.push([id, handle])
            },
            bindToken: async (id: string, tokenId: string) => {
                tokens.push([id, tokenId])
            },
            findById: async (id: string) => ({
                id,
                agentId: 'agt-1',
                endedAt: null,
                client: 'herdr',
                daemonId: null,
                ...overrides.row
            })
        } as never,
        {
            acquire: async (args: Record<string, unknown>) => {
                acquires.push(args)
                return overrides.acquire ?? 'applied'
            },
            finish: async (id: string, cause: string) => {
                finished.push([id, cause])
            }
        } as never,
        {
            openInHerdr: async (req: Record<string, unknown>) => {
                opens.push(req)
                ;(req.onToken as (t: string) => void)?.('tok-1')
                return overrides.open
                    ? overrides.open()
                    : {
                          paneId: 'w1:p2',
                          tabId: 'w1:t2',
                          workspaceId: 'w1',
                          focused: true
                      }
            },
            focusHerdr: async (daemonId: string, terminalId: string) => {
                focuses.push([daemonId, terminalId])
                return true
            },
            preparePiView: async (
                daemonId: string,
                env: Record<string, string>
            ) => {
                prepares.push([daemonId, env])
                return overrides.preparePiView
                    ? overrides.preparePiView(daemonId, env)
                    : '/home/sprite/.manyfold/pi/rt-1/agent'
            }
        } as never,
        ...(overrides.runner
            ? [
                  {
                      resolveRuntimeHost: async () => overrides.runner
                  } as never,
                  {
                      findHostById: async () => overrides.sandbox ?? null
                  } as never
              ]
            : [])
    )
    return {
        service,
        created,
        resolves,
        handles,
        tokens,
        acquires,
        finished,
        opens,
        focuses,
        prepares
    }
}

test('a handoff creates a herdr terminal row, takes the hold as herdr, and reports the pane', async () => {
    const h = harness()
    const result = await h.service.open('u1', 'agt-1', 'cs-1', {})
    assert.deepEqual(result, {
        terminalId: 'tms_new',
        herdr: {
            paneId: 'w1:p2',
            tabId: 'w1:t2',
            workspaceId: 'w1',
            focused: true
        }
    })
    assert.equal(h.created[0].client, 'herdr')
    assert.deepEqual(h.handles, [['tms_new', 'tms_new']])
    assert.equal(h.acquires[0].client, 'herdr')
    assert.equal(h.acquires[0].expectedRef, 'ref-1')
    // The hold is taken before herdr is asked.
    assert.equal(h.acquires.length, 1)
    assert.equal(h.opens.length, 1)
    assert.equal(h.opens[0].title, 'Fix the login bug')
    assert.equal(h.opens[0].chatSessionId, 'cs-1')
    assert.equal(h.opens[0].terminalId, 'tms_new')
    assert.deepEqual(h.tokens, [['tms_new', 'tok-1']])
    assert.deepEqual(h.finished, [])
})

test('the web title wins, then the session title, then the agent name; control characters are dropped', async () => {
    const h = harness({ session: { title: null } })
    await h.service.open('u1', 'agt-1', 'cs-1', { title: ' Web\u0007 title ' })
    assert.equal(h.opens[0].title, 'Web  title')
    const fallback = harness({ session: { title: null } })
    await fallback.service.open('u1', 'agt-1', 'cs-1', {})
    assert.equal(fallback.opens[0].title, 'Reviewer')
})

test('a launch herdr refuses ends the row as failed, which releases the hold', async () => {
    const h = harness({
        open: async () => {
            throw new DaemonRpcResponseError(
                'herdr_not_running: herdr is not running'
            )
        }
    })
    await assert.rejects(
        h.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) =>
            codeOf(err) === HERDR_NOT_RUNNING_CODE &&
            (err as HttpException).getStatus() === 503
    )
    assert.deepEqual(h.finished, [['tms_new', 'tunnel-failed']])
    const other = harness({
        open: async () => {
            throw new DaemonRpcResponseError('invalid terminalId')
        }
    })
    await assert.rejects(
        other.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) =>
            codeOf(err) === HERDR_LAUNCH_FAILED_CODE &&
            (err as HttpException).getStatus() === 502
    )
    const silent = harness({
        open: async () => {
            throw new Error('rpc terminal.herdr.open timed out')
        }
    })
    await assert.rejects(
        silent.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) => codeOf(err) === HERDR_UNAVAILABLE_CODE
    )
})

test('a lost acquire ends the row and says who has the session', async () => {
    const held = harness({ acquire: 'session-held' })
    await assert.rejects(
        held.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) => codeOf(err) === CHAT_SESSION_HELD_BY_TERMINAL_CODE
    )
    assert.deepEqual(held.finished, [['tms_new', 'tunnel-failed']])
    assert.equal(held.opens.length, 0)
    const turn = harness({ acquire: 'turn-in-flight' })
    await assert.rejects(
        turn.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) => codeOf(err) === CHAT_SESSION_TURN_IN_FLIGHT_CODE
    )
})

test('a running turn or a session without a ref is refused before any row exists', async () => {
    const inflight = harness({
        resolve: { resume: null, outcome: 'turn-in-flight', ref: null }
    })
    await assert.rejects(
        inflight.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) => codeOf(err) === CHAT_SESSION_TURN_IN_FLIGHT_CODE
    )
    assert.equal(inflight.created.length, 0)
    const noRef = harness({
        resolve: { resume: null, outcome: 'unavailable', ref: null }
    })
    await assert.rejects(
        noRef.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) => codeOf(err) === HERDR_UNAVAILABLE_CODE
    )
    assert.equal(noRef.created.length, 0)
})

test('only a running agent on an online self-owned computer that advertises herdr can hand off', async () => {
    const cases: Array<[string, Parameters<typeof harness>[0], number]> = [
        [
            'a sprites agent where sandboxes cannot reach herdr',
            { agent: { runtime: 'sprites', daemonId: null } },
            409
        ],
        ['a stopped agent', { agent: { status: 'stopped' } }, 409],
        ['an offline computer', { online: false }, 503],
        [
            'a daemon without herdr',
            { host: { clientFeatures: [DAEMON_FEATURE_PTY_COMMAND] } },
            409
        ],
        [
            'a daemon too old to run a command',
            { host: { clientFeatures: [DAEMON_FEATURE_HERDR_TERMINAL] } },
            409
        ],
        [
            'a framework without a resume form',
            { agent: { framework: 'gemini-cli' } },
            409
        ]
    ]
    for (const [label, overrides, status] of cases) {
        const h = harness(overrides)
        await assert.rejects(
            h.service.open('u1', 'agt-1', 'cs-1', {}),
            (err: unknown) =>
                codeOf(err) === HERDR_UNAVAILABLE_CODE &&
                (err as HttpException).getStatus() === status,
            label
        )
        assert.equal(h.created.length, 0, label)
    }
})

test('focus reaches the daemon only for a session herdr holds', async () => {
    const h = harness({
        session: { holderTerminalId: 'tms_h', holderClient: 'herdr' }
    })
    assert.deepEqual(await h.service.focus('u1', 'agt-1', 'cs-1'), {
        focused: true
    })
    assert.deepEqual(h.focuses, [['dh-1', 'tms_h']])
    const web = harness({
        session: { holderTerminalId: 'tms_h', holderClient: 'web' }
    })
    await assert.rejects(
        web.service.focus('u1', 'agt-1', 'cs-1'),
        (err: unknown) => codeOf(err) === HERDR_UNAVAILABLE_CODE
    )
    const free = harness()
    await assert.rejects(
        free.service.focus('u1', 'agt-1', 'cs-1'),
        (err: unknown) => codeOf(err) === HERDR_UNAVAILABLE_CODE
    )
})

// The sprites arm (ADR-0031): the sandbox's runner daemon hosts herdr, so
// the row and the pane are addressed through it, not through the agent.
const SPRITES_AGENT = {
    runtime: 'sprites',
    daemonId: null,
    hostId: 'sbx-1',
    runtimeId: 'rt-1'
}
const SANDBOX = {
    id: 'sbx-1',
    herdrVersion: '0.9.1',
    terminalEnabled: true,
    terminalModelCredentials: true
}
const RUNNER = {
    id: 'dh-runner',
    clientFeatures: [DAEMON_FEATURE_PTY_COMMAND, DAEMON_FEATURE_HERDR_TERMINAL]
}

test('a sprites agent hands off through its sandbox runner, with the row addressed to that daemon', async () => {
    const h = harness({
        agent: SPRITES_AGENT,
        sandbox: SANDBOX,
        runner: { host: RUNNER, availability: 'ok' }
    })
    const result = await h.service.open('u1', 'agt-1', 'cs-1', {})
    assert.equal(result.terminalId, 'tms_new')
    assert.equal(h.created[0].runtime, 'sprites')
    assert.equal(h.created[0].hostId, 'sbx-1')
    assert.equal(h.created[0].daemonId, 'dh-runner')
    assert.equal(h.opens[0].daemonId, 'dh-runner')
    // The sandbox opted in to lending the platform's credentials, and a
    // sandbox TUI gets them injected as the browser terminal does.
    assert.equal(h.resolves[0].modelCredentialsAllowed, true)
    assert.equal(h.resolves[0].injectModelCredentials, true)
    // Without that opt-in a Claude Code TUI has nothing to answer with,
    // and the refusal names the setting instead of "nothing to resume";
    // codex needs no model credentials and goes ahead.
    const noLending = harness({
        agent: SPRITES_AGENT,
        sandbox: { ...SANDBOX, terminalModelCredentials: false },
        runner: { host: RUNNER, availability: 'ok' }
    })
    await assert.rejects(
        noLending.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) =>
            codeOf(err) === HERDR_UNAVAILABLE_CODE &&
            /model credentials in the terminal/.test(
                (err as HttpException).message
            )
    )
    assert.equal(noLending.created.length, 0)
    const codex = harness({
        agent: { ...SPRITES_AGENT, framework: 'codex' },
        sandbox: { ...SANDBOX, terminalModelCredentials: false },
        runner: { host: RUNNER, availability: 'ok' },
        resolve: {
            resume: { command: ['codex', 'resume', 'ref-1'], env: {} },
            outcome: 'applied',
            ref: 'ref-1'
        }
    })
    await codex.service.open('u1', 'agt-1', 'cs-1', {})
    assert.equal(codex.resolves[0].modelCredentialsAllowed, false)
})

test('a sandbox needs herdr installed, its terminal enabled and a ready runner that can reach it', async () => {
    const cases: Array<[string, Parameters<typeof harness>[0], number]> = [
        [
            'a sandbox with its terminal switched off',
            {
                agent: SPRITES_AGENT,
                sandbox: { ...SANDBOX, terminalEnabled: false },
                runner: { host: RUNNER, availability: 'ok' }
            },
            409
        ],
        [
            'no herdr in the sandbox',
            {
                agent: SPRITES_AGENT,
                sandbox: { ...SANDBOX, herdrVersion: null },
                runner: { host: RUNNER, availability: 'ok' }
            },
            409
        ],
        [
            'a runner still waking',
            {
                agent: SPRITES_AGENT,
                sandbox: SANDBOX,
                runner: { host: RUNNER, availability: 'starting' }
            },
            503
        ],
        [
            'a runner too old for herdr',
            {
                agent: SPRITES_AGENT,
                sandbox: SANDBOX,
                runner: {
                    host: {
                        ...RUNNER,
                        clientFeatures: [DAEMON_FEATURE_PTY_COMMAND]
                    },
                    availability: 'ok'
                }
            },
            409
        ]
    ]
    for (const [label, overrides, status] of cases) {
        const h = harness(overrides)
        await assert.rejects(
            h.service.open('u1', 'agt-1', 'cs-1', {}),
            (err: unknown) =>
                codeOf(err) === HERDR_UNAVAILABLE_CODE &&
                (err as HttpException).getStatus() === status,
            label
        )
        assert.equal(h.created.length, 0, label)
    }
})

test('focus for a sandbox session goes to the daemon the row names', async () => {
    const h = harness({
        agent: SPRITES_AGENT,
        sandbox: SANDBOX,
        runner: { host: RUNNER, availability: 'ok' },
        session: { holderTerminalId: 'tms_h', holderClient: 'herdr' },
        row: { daemonId: 'dh-runner' }
    })
    assert.deepEqual(await h.service.focus('u1', 'agt-1', 'cs-1'), {
        focused: true
    })
    assert.deepEqual(h.focuses, [['dh-runner', 'tms_h']])
})

// pi joins herdr (its `pi` agent kind) wherever the CLI there knows it.
const PI_HOST = {
    id: 'dh-1',
    clientFeatures: [
        DAEMON_FEATURE_PTY_COMMAND,
        DAEMON_FEATURE_HERDR_TERMINAL,
        DAEMON_FEATURE_HERDR_PI
    ]
}

test('a pi conversation on a computer whose CLI knows pi goes to herdr as plain pi', async () => {
    const h = harness({
        agent: { framework: 'pi' },
        host: PI_HOST,
        resolve: {
            resume: {
                command: ['pi', '--session-id', 'ref-1', '--approve'],
                env: {}
            },
            outcome: 'applied',
            ref: 'ref-1'
        }
    })
    await h.service.open('u1', 'agt-1', 'cs-1', {})
    // The machine's own sign-in answers there: nothing to prepare.
    assert.equal(h.prepares.length, 0)
    assert.deepEqual((h.opens[0].resume as { command: string[] }).command, [
        'pi',
        '--session-id',
        'ref-1',
        '--approve'
    ])
    assert.equal(h.opens[0].framework, 'pi')

    // A CLI from before pi joined herdr hands over claude and codex only.
    const old = harness({ agent: { framework: 'pi' } })
    await assert.rejects(
        old.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) =>
            codeOf(err) === HERDR_UNAVAILABLE_CODE &&
            /update the Manyfold CLI/.test((err as HttpException).message)
    )
    assert.equal(old.created.length, 0)
})

// On a sandbox a platform pi runs on the platform view. herdr starts pi by
// name, so the runner builds the view first and herdr's pi is pointed at it,
// with the key and nothing of the view's own variables.
test('a sandbox pi on the platform key gets its view built by the runner before herdr starts it', async () => {
    const h = harness({
        agent: { ...SPRITES_AGENT, framework: 'pi' },
        sandbox: SANDBOX,
        runner: {
            host: { ...RUNNER, clientFeatures: PI_HOST.clientFeatures },
            availability: 'ok'
        },
        resolve: {
            resume: {
                command: [
                    'bash',
                    '-c',
                    'view script',
                    'pi',
                    '--session-id',
                    'ref-1',
                    '--approve'
                ],
                env: {
                    PI_OFFLINE: '1',
                    MF_PI_VIEW: 'rt-1',
                    MF_PI_MODELS_JSON: '{"providers":{}}',
                    ANTHROPIC_API_KEY: 'sk-bound',
                    ANTHROPIC_AUTH_TOKEN: ''
                }
            },
            outcome: 'applied',
            ref: 'ref-1'
        }
    })
    await h.service.open('u1', 'agt-1', 'cs-1', {})
    assert.equal(h.prepares.length, 1)
    assert.equal(h.prepares[0][0], 'dh-runner')
    assert.equal(h.prepares[0][1].MF_PI_VIEW, 'rt-1')
    const resume = h.opens[0].resume as {
        command: string[]
        env: Record<string, string>
    }
    assert.deepEqual(resume.command, [
        'pi',
        '--session-id',
        'ref-1',
        '--approve'
    ])
    assert.deepEqual(resume.env, {
        PI_OFFLINE: '1',
        ANTHROPIC_API_KEY: 'sk-bound',
        ANTHROPIC_AUTH_TOKEN: '',
        PI_CODING_AGENT_DIR: '/home/sprite/.manyfold/pi/rt-1/agent'
    })

    // A view that cannot be built stops the handoff before any row exists.
    const failed = harness({
        agent: { ...SPRITES_AGENT, framework: 'pi' },
        sandbox: SANDBOX,
        runner: {
            host: { ...RUNNER, clientFeatures: PI_HOST.clientFeatures },
            availability: 'ok'
        },
        resolve: {
            resume: {
                command: [
                    'bash',
                    '-c',
                    'view script',
                    'pi',
                    '--session-id',
                    'ref-1'
                ],
                env: { MF_PI_VIEW: 'rt-1', ANTHROPIC_API_KEY: 'sk-bound' }
            },
            outcome: 'applied',
            ref: 'ref-1'
        },
        preparePiView: async () => {
            throw new DaemonRpcResponseError('exec failed')
        }
    })
    await assert.rejects(
        failed.service.open('u1', 'agt-1', 'cs-1', {}),
        (err: unknown) => codeOf(err) === HERDR_LAUNCH_FAILED_CODE
    )
    assert.equal(failed.created.length, 0)
})
