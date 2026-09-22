import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { createObjectId } from '@manyfold/shared'
import {
    closeHerdrTerminal,
    configureHerdr,
    focusHerdrTerminal,
    herdrAgentName,
    herdrSocketPath,
    herdrTerminal,
    HerdrError,
    listHerdrTerminals,
    openInHerdr,
    paneShellIdle,
    resetHerdrForTest
} from '../src/daemon/herdr'
import { rpcHandler } from '../src/daemon/rpc'

// The daemon's side of a herdr handoff (ADR-0031), against a fake herdr
// server on a unix socket speaking herdr's newline-JSON protocol: a
// workspace per agent and a tab per session are created with the platform
// env on the shell, the framework CLI is started through herdr's agent
// surface, the pane is labelled and raised, and the terminal is listed in
// the inventory until herdr says the pane is gone or the poll sees the TUI
// quit — at which point the pane is closed and the inventory changes at
// once.

interface Call {
    method: string
    params: Record<string, unknown>
}

class FakeHerdr {
    readonly calls: Call[] = []
    readonly subscribers: Socket[] = []
    readonly dir = mkdtempSync(join('/tmp', 'mfh-'))
    readonly socketPath = join(this.dir, 'h.sock')
    private server: Server | null = null
    // What pane.process_info reports: the shell alone, or a TUI in front.
    shellIdle = true
    workspaces: Array<{ workspace_id: string; label: string }> = []
    failures = new Map<string, { code: string; message: string }>()

    private result(call: Call): Record<string, unknown> {
        switch (call.method) {
            case 'ping':
                return { type: 'pong' }
            case 'workspace.list':
                return { type: 'workspace_list', workspaces: this.workspaces }
            case 'workspace.create': {
                const id = `w${this.workspaces.length + 1}`
                this.workspaces.push({
                    workspace_id: id,
                    label: String(call.params.label)
                })
                return {
                    type: 'workspace_created',
                    workspace: { workspace_id: id },
                    tab: { tab_id: `${id}:t1` },
                    root_pane: { pane_id: `${id}:p1` }
                }
            }
            case 'tab.create':
                return {
                    type: 'tab_created',
                    tab: { tab_id: `${call.params.workspace_id}:t2` },
                    root_pane: { pane_id: `${call.params.workspace_id}:p2` }
                }
            case 'agent.start':
                return {
                    type: 'agent_started',
                    agent: {
                        pane_id: call.params.pane_id,
                        agent_status: 'idle'
                    },
                    argv: [call.params.kind, ...(call.params.args as string[])]
                }
            case 'pane.process_info':
                return {
                    type: 'pane_process_info',
                    process_info: {
                        pane_id: call.params.pane_id,
                        shell_pid: 100,
                        foreground_processes: this.shellIdle
                            ? [{ pid: 100, name: 'zsh' }]
                            : [
                                  { pid: 100, name: 'zsh' },
                                  { pid: 200, name: 'claude' }
                              ]
                    }
                }
            default:
                return { type: 'ok' }
        }
    }

    calls_(method: string): Call[] {
        return this.calls.filter((c) => c.method === method)
    }

    async start(): Promise<void> {
        this.server = createServer((socket) => {
            let buffer = ''
            socket.setEncoding('utf8')
            socket.on('data', (chunk: string) => {
                buffer += chunk
                let newline = buffer.indexOf('\n')
                while (newline >= 0) {
                    const line = buffer.slice(0, newline)
                    buffer = buffer.slice(newline + 1)
                    newline = buffer.indexOf('\n')
                    if (!line.trim()) continue
                    const request = JSON.parse(line) as {
                        id: string
                        method: string
                        params: Record<string, unknown>
                    }
                    const call = {
                        method: request.method,
                        params: request.params ?? {}
                    }
                    this.calls.push(call)
                    if (request.method === 'events.subscribe') {
                        this.subscribers.push(socket)
                        socket.write(
                            `${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`
                        )
                        continue
                    }
                    const failure = this.failures.get(request.method)
                    if (failure) {
                        socket.write(
                            `${JSON.stringify({ id: request.id, error: failure })}\n`
                        )
                        continue
                    }
                    socket.write(
                        `${JSON.stringify({ id: request.id, result: this.result(call) })}\n`
                    )
                }
            })
            socket.on('error', () => {})
        })
        await new Promise<void>((resolve) =>
            this.server!.listen(this.socketPath, resolve)
        )
    }

    pushEvent(event: string, data: Record<string, unknown>): void {
        for (const socket of this.subscribers)
            try {
                socket.write(`${JSON.stringify({ event, data })}\n`)
            } catch {}
    }

    async stop(): Promise<void> {
        for (const socket of this.subscribers) socket.destroy()
        await new Promise<void>((resolve) =>
            this.server ? this.server.close(() => resolve()) : resolve()
        )
        rmSync(this.dir, { recursive: true, force: true })
    }
}

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 4_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

const COMMAND = [
    'claude',
    '--resume',
    'sess-1',
    '--dangerously-skip-permissions'
]
const ENV = { MF_TERMINAL_ID: 'tms_x', MF_API_TOKEN: 'nca_secret' }

let fake: FakeHerdr
let inventoryChanges = 0

beforeEach(async () => {
    resetHerdrForTest()
    fake = new FakeHerdr()
    await fake.start()
    inventoryChanges = 0
    configureHerdr({
        onInventoryChange: () => {
            inventoryChanges += 1
        },
        timing: { pollIntervalMs: 40, exitMinUptimeMs: 60_000 }
    })
})

afterEach(async () => {
    resetHerdrForTest()
    await fake.stop()
})

const open = (overrides: Partial<Parameters<typeof openInHerdr>[0]> = {}) =>
    openInHerdr({
        terminalId: createObjectId('terminalSession'),
        framework: 'claude-code',
        command: COMMAND,
        cwd: '/tmp/ws',
        env: ENV,
        title: 'Fix the login bug',
        agentName: 'Reviewer',
        socketPath: fake.socketPath,
        ...overrides
    })

test('the socket path follows herdr: explicit path, then a named session, then the default', () => {
    assert.equal(
        herdrSocketPath({ HERDR_SOCKET_PATH: '/x/h.sock', HERDR_SESSION: 'a' }),
        '/x/h.sock'
    )
    assert.match(
        herdrSocketPath({ HERDR_SESSION: 'mf-test' }),
        /\/\.config\/herdr\/sessions\/mf-test\/herdr\.sock$/
    )
    assert.match(herdrSocketPath({}), /\/\.config\/herdr\/herdr\.sock$/)
    assert.equal(
        herdrSocketPath({ HERDR_CONFIG_PATH: '/etc/herdr/config.toml' }),
        '/etc/herdr/herdr.sock'
    )
})

test('the agent name is a herdr handle cut from the terminal id', () => {
    const id = createObjectId('terminalSession')
    const name = herdrAgentName(id)
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/)
    assert.equal(name, `mf-${id.slice(-8)}`)
})

test('a pane is idle when nothing but its shell is in the foreground', () => {
    assert.equal(
        paneShellIdle({ shell_pid: 1, foreground_processes: [] }),
        true
    )
    assert.equal(
        paneShellIdle({
            shell_pid: 1,
            foreground_processes: [{ pid: 1, name: 'zsh' }]
        }),
        true
    )
    assert.equal(
        paneShellIdle({
            shell_pid: 1,
            foreground_processes: [
                { pid: 1, name: 'zsh' },
                { pid: 2, name: 'claude' }
            ]
        }),
        false
    )
})

test('the first handoff for an agent creates its workspace, names the tab after the session and starts the CLI through herdr', async () => {
    fake.shellIdle = true
    const terminalId = createObjectId('terminalSession')
    const result = await open({ terminalId })
    assert.deepEqual(result, {
        paneId: 'w1:p1',
        tabId: 'w1:t1',
        workspaceId: 'w1',
        focused: true
    })
    const created = fake.calls_('workspace.create')
    assert.equal(created.length, 1)
    assert.deepEqual(created[0].params, {
        cwd: '/tmp/ws',
        env: ENV,
        label: 'Reviewer',
        focus: false
    })
    assert.deepEqual(fake.calls_('tab.rename')[0].params, {
        tab_id: 'w1:t1',
        label: 'Fix the login bug'
    })
    const started = fake.calls_('agent.start')
    assert.equal(started.length, 1)
    assert.deepEqual(started[0].params, {
        name: herdrAgentName(terminalId),
        kind: 'claude',
        pane_id: 'w1:p1',
        args: ['--resume', 'sess-1', '--dangerously-skip-permissions'],
        timeout_ms: 60_000
    })
    assert.deepEqual(fake.calls_('pane.rename')[0].params, {
        pane_id: 'w1:p1',
        label: 'Fix the login bug'
    })
    assert.equal(
        fake.calls_('pane.report_metadata')[0].params.title,
        'Fix the login bug'
    )
    assert.equal(fake.calls_('pane.focus').length, 1)
    assert.equal(fake.calls_('notification.show').length, 1)
    // The shell prompt was waited for before the start.
    const order = fake.calls.map((c) => c.method)
    assert.ok(order.indexOf('pane.process_info') < order.indexOf('agent.start'))
    assert.deepEqual(
        listHerdrTerminals().map((t) => ({
            id: t.terminalId,
            attached: t.attached
        })),
        [{ id: terminalId, attached: true }]
    )
    assert.equal(inventoryChanges, 1)
})

test('a second session for the same agent lands in a new tab of the existing workspace', async () => {
    await open({ title: 'first' })
    await open({
        title: 'second',
        terminalId: createObjectId('terminalSession')
    })
    assert.equal(fake.calls_('workspace.create').length, 1)
    const tabs = fake.calls_('tab.create')
    assert.equal(tabs.length, 1)
    assert.deepEqual(tabs[0].params, {
        workspace_id: 'w1',
        cwd: '/tmp/ws',
        env: ENV,
        label: 'second',
        focus: false
    })
    assert.equal(listHerdrTerminals().length, 2)
})

test('a start herdr refuses closes the pane it made and reports a launch failure', async () => {
    fake.failures.set('agent.start', {
        code: 'invalid_params',
        message: 'pane is not at a shell prompt'
    })
    await assert.rejects(open(), (err: unknown) => {
        assert.ok(err instanceof HerdrError)
        assert.equal(err.code, 'herdr_launch_failed')
        assert.match(err.message, /invalid_params/)
        return true
    })
    assert.deepEqual(fake.calls_('pane.close')[0].params, { pane_id: 'w1:p1' })
    assert.equal(listHerdrTerminals().length, 0)
})

test('a TUI blocked at a startup prompt still counts as running', async () => {
    fake.failures.set('agent.start', {
        code: 'agent_not_ready',
        message: 'blocked'
    })
    const result = await open()
    assert.equal(result.paneId, 'w1:p1')
    assert.equal(listHerdrTerminals().length, 1)
})

test('a command that does not run the framework CLI is refused before herdr is touched', async () => {
    await assert.rejects(
        open({ command: ['bash', '-c', 'rm -rf /'] }),
        (err: unknown) =>
            err instanceof HerdrError && err.code === 'herdr_launch_failed'
    )
    assert.equal(fake.calls.length, 0)
})

test('no herdr server means herdr_not_running', async () => {
    await assert.rejects(
        open({ socketPath: join(fake.dir, 'absent.sock') }),
        (err: unknown) =>
            err instanceof HerdrError && err.code === 'herdr_not_running'
    )
})

test('herdr closing the pane or its tab forgets the terminal and nudges the inventory', async () => {
    fake.shellIdle = true
    const first = createObjectId('terminalSession')
    await open({ terminalId: first })
    const second = createObjectId('terminalSession')
    await open({ terminalId: second, title: 'other' })
    fake.shellIdle = false
    await waitFor(() => fake.subscribers.length > 0, 'subscription')
    inventoryChanges = 0
    fake.pushEvent('pane_closed', { pane_id: 'w1:p1', workspace_id: 'w1' })
    await waitFor(() => herdrTerminal(first) === null, 'first forgotten')
    assert.equal(inventoryChanges, 1)
    fake.pushEvent('tab_closed', { tab_id: 'w1:t2', workspace_id: 'w1' })
    await waitFor(() => herdrTerminal(second) === null, 'second forgotten')
    assert.equal(inventoryChanges, 2)
    assert.equal(listHerdrTerminals().length, 0)
})

test('the poll sees the TUI quit, closes the bare shell pane and forgets the terminal', async () => {
    fake.shellIdle = true
    const terminalId = createObjectId('terminalSession')
    await open({ terminalId })
    // The TUI runs; the poll leaves it alone, however young the terminal.
    fake.shellIdle = false
    configureHerdr({ timing: { exitMinUptimeMs: 0 } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(herdrTerminal(terminalId))
    assert.equal(fake.calls_('pane.close').length, 0)
    // It quits: the pane is closed and the inventory changes.
    fake.shellIdle = true
    await waitFor(() => herdrTerminal(terminalId) === null, 'TUI exit noticed')
    assert.deepEqual(fake.calls_('pane.close')[0].params, { pane_id: 'w1:p1' })
})

test('pty.close by terminal id reaches herdr for a herdr-hosted terminal', async () => {
    const terminalId = createObjectId('terminalSession')
    await open({ terminalId })
    fake.shellIdle = false
    const ack = await rpcHandler(
        'pty.close',
        { terminalId },
        {
            refId: 'r1',
            sendEvent: () => {},
            onCancel: () => {}
        }
    )
    assert.deepEqual(ack, { ok: true })
    assert.deepEqual(fake.calls_('pane.close')[0].params, { pane_id: 'w1:p1' })
    assert.equal(herdrTerminal(terminalId), null)
    assert.equal(await closeHerdrTerminal(terminalId), false)
})

test('focus raises the pane again and a gone pane is forgotten', async () => {
    const terminalId = createObjectId('terminalSession')
    await open({ terminalId })
    fake.shellIdle = false
    fake.calls.length = 0
    assert.deepEqual(await focusHerdrTerminal(terminalId), { focused: true })
    assert.deepEqual(fake.calls_('pane.focus')[0].params, { pane_id: 'w1:p1' })
    fake.failures.set('pane.focus', {
        code: 'not_found',
        message: 'pane not found'
    })
    await assert.rejects(focusHerdrTerminal(terminalId))
    assert.equal(herdrTerminal(terminalId), null)
    await assert.rejects(
        focusHerdrTerminal(terminalId),
        (err: unknown) => err instanceof HerdrError && err.code === 'not_found'
    )
})
