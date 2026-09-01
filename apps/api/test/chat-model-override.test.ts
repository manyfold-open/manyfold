import {
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ExecDriver,
    ExecStreamRequest
} from '../src/modules/chat/adapters/exec-driver'

const EXEC_TIMEOUTS = resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)

const userMessage: ChatMessage = {
    id: 'msg-user',
    sessionId: 'session-1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hello' }],
    createdAt: new Date().toISOString()
}

const baseCtx: ApiChatAdapterContext = {
    userId: 'user-1',
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    sessionId: 'session-1',
    messageId: 'msg-assistant',
    framework: 'claude-code',
    runtimeKind: 'sprites',
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
    frameworkSessionRef: null,
    history: []
}

test('ChatService rejects unsupported model override before inserting messages', async () => {
    let inserted = 0
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ framework: 'openclaw' }]
                })
            })
        })
    }
    const repo = {
        getSession: async () => ({
            id: 'session-1',
            userId: 'user-1',
            agentId: 'agent-1'
        }),
        insertMessage: async () => {
            inserted += 1
            return userMessage
        }
    }
    const service = new ChatService(
        db as never,
        repo as never,
        {} as never,
        { get: () => ({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        { event: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

    await assert.rejects(
        () =>
            service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hello',
                [],
                'gpt-5.4'
            ),
        BadRequestException
    )
    assert.equal(inserted, 0)
})

// The gate half of hermes model switching: an override now passes
// assertTurnOptions for hermes (the harness lacks the resolver, so the send
// fails LATER with something that is not the gate's BadRequestException).
test('ChatService accepts a hermes model override at the gate', async () => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ framework: 'hermes' }]
                })
            })
        })
    }
    const repo = {
        getSession: async () => ({
            id: 'session-1',
            userId: 'user-1',
            agentId: 'agent-1'
        }),
        insertMessage: async () => userMessage
    }
    const service = new ChatService(
        db as never,
        repo as never,
        {} as never,
        { get: () => ({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        { event: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )
    await assert.rejects(
        () =>
            service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hello',
                [],
                'z-ai/glm-5.1'
            ),
        (err) => !(err instanceof BadRequestException)
    )
})

test('ChatService rejects Claude permission mode for non-Claude agents before inserting messages', async () => {
    let inserted = 0
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ framework: 'codex' }]
                })
            })
        })
    }
    const repo = {
        getSession: async () => ({
            id: 'session-1',
            userId: 'user-1',
            agentId: 'agent-1'
        }),
        insertMessage: async () => {
            inserted += 1
            return userMessage
        }
    }
    const service = new ChatService(
        db as never,
        repo as never,
        {} as never,
        { get: () => ({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        { event: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

    await assert.rejects(
        () =>
            service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hello',
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                'auto'
            ),
        BadRequestException
    )
    assert.equal(inserted, 0)
})

test('Claude adapter passes model override to CLI', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )

    await drain(
        adapter.sendMessage(
            { ...baseCtx, framework: 'claude-code', model: 'opus' },
            userMessage
        )
    )

    assert.deepEqual(handle.request?.cmd.slice(0, 7), [
        'claude',
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        'opus'
    ])
    const permissionIndex =
        handle.request?.cmd.indexOf('--permission-mode') ?? -1
    assert.notEqual(permissionIndex, -1)
    assert.equal(handle.request?.cmd[permissionIndex + 1], 'bypassPermissions')
})

test('Claude adapter applies non-default permission modes', async () => {
    for (const mode of [
        'acceptEdits',
        'plan',
        'auto',
        'bypassPermissions',
        'dontAsk'
    ] as const) {
        const handle = makeDriverFactory({
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        })
        const adapter = new ClaudeCodeAdapter(
            handle.drivers as never,
            { updateFrameworkSessionRef: async () => undefined } as never
        )

        await drain(
            adapter.sendMessage(
                {
                    ...baseCtx,
                    framework: 'claude-code',
                    claudeCodePermissionMode: mode
                },
                userMessage
            )
        )

        const index = handle.request?.cmd.indexOf('--permission-mode') ?? -1
        assert.notEqual(index, -1)
        assert.equal(handle.request?.cmd[index + 1], mode)
    }
})

test('Claude adapter injects alias mappings and effort', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                model: 'sonnet',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'sonnet',
                    effort: 'high',
                    modelMap: {
                        opus: 'anthropic/claude-opus-x',
                        sonnet: 'anthropic/claude-sonnet-4-6',
                        haiku: 'anthropic/claude-haiku-x'
                    }
                }
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('--effort'))
    assert.ok(handle.request?.cmd.includes('high'))
    assert.equal(
        handle.request?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
        'anthropic/claude-sonnet-4-6'
    )
})

test('Claude adapter normalizes unsupported selected effort', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                model: 'sonnet',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'sonnet',
                    effort: 'xhigh',
                    modelMap: {
                        sonnet: 'anthropic/claude-sonnet-4-6'
                    }
                }
            },
            userMessage
        )
    )

    const index = handle.request?.cmd.indexOf('--effort') ?? -1
    assert.notEqual(index, -1)
    assert.equal(handle.request?.cmd[index + 1], 'medium')
})

test('Claude adapter omits effort for unsupported provider models', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                model: 'haiku',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'haiku',
                    effort: 'high',
                    modelMap: {
                        haiku: 'anthropic/claude-haiku-4-5'
                    }
                }
            },
            userMessage
        )
    )

    assert.ok(!handle.request?.cmd.includes('--effort'))
})

test('Claude adapter keeps xhigh on a supporting CLI across every exec boundary', async () => {
    for (const runtime of ['sprites', 'k8s', 'daemon'] as const) {
        const handle = makeDriverFactory(
            {
                anthropicAuthToken: 'token',
                anthropicBaseUrl: 'https://api.example.test'
            },
            runtime,
            '',
            {},
            { claudeVersion: '2.1.111' }
        )
        const adapter = new ClaudeCodeAdapter(
            handle.drivers as never,
            { updateFrameworkSessionRef: async () => undefined } as never
        )

        await drain(
            adapter.sendMessage(
                {
                    ...baseCtx,
                    framework: 'claude-code',
                    model: 'opus',
                    modelConfig: {
                        framework: 'claude-code',
                        model: 'opus',
                        effort: 'xhigh',
                        modelMap: {
                            opus: 'anthropic/claude-opus-4-7'
                        }
                    }
                },
                userMessage
            )
        )

        assert.deepEqual(handle.requests[0]?.cmd, ['claude', '--version'])
        const index = handle.request?.cmd.indexOf('--effort') ?? -1
        assert.notEqual(index, -1, runtime)
        assert.equal(handle.request?.cmd[index + 1], 'xhigh', runtime)
    }
})

test('Claude adapter falls back from xhigh on an older CLI across every exec boundary', async () => {
    for (const runtime of ['sprites', 'k8s', 'daemon'] as const) {
        const handle = makeDriverFactory(
            {
                anthropicAuthToken: 'token',
                anthropicBaseUrl: 'https://api.example.test'
            },
            runtime,
            '',
            {},
            { claudeVersion: '2.1.110' }
        )
        const adapter = new ClaudeCodeAdapter(
            handle.drivers as never,
            { updateFrameworkSessionRef: async () => undefined } as never
        )

        await drain(
            adapter.sendMessage(
                {
                    ...baseCtx,
                    framework: 'claude-code',
                    model: 'opus',
                    modelConfig: {
                        framework: 'claude-code',
                        model: 'opus',
                        effort: 'xhigh',
                        modelMap: {
                            opus: 'anthropic/claude-opus-4-7'
                        }
                    }
                },
                userMessage
            )
        )

        const index = handle.request?.cmd.indexOf('--effort') ?? -1
        assert.notEqual(index, -1, runtime)
        assert.equal(handle.request?.cmd[index + 1], 'high', runtime)
    }
})

test('Claude adapter records an attributable fallback when CLI version cannot be probed', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'sprites',
        '',
        {},
        { claudeVersion: null, claudeVersionExitCode: 1 }
    )
    const telemetry: Array<{ event: string; attrs: Record<string, unknown> }> =
        []
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        undefined,
        {
            event: (event: string, attrs: Record<string, unknown>) =>
                telemetry.push({ event, attrs })
        } as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                model: 'opus',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'opus',
                    effort: 'xhigh',
                    modelMap: { opus: 'anthropic/claude-opus-4-7' }
                }
            },
            userMessage
        )
    )

    const index = handle.request?.cmd.indexOf('--effort') ?? -1
    assert.equal(handle.request?.cmd[index + 1], 'high')
    assert.deepEqual(telemetry, [
        {
            event: 'chat.claude.effort_fallback',
            attrs: {
                agentId: 'agent-1',
                sessionId: 'session-1',
                messageId: 'msg-assistant',
                runtimeKind: 'sprites',
                requestedEffort: 'xhigh',
                effectiveEffort: 'high',
                cliVersion: null,
                minimumCliVersion: '2.1.111',
                reason: 'unknown_cli'
            }
        }
    ])
})

test('Claude adapter passes through every advertised effort unchanged on a current CLI', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
        const handle = makeDriverFactory(
            {
                anthropicAuthToken: 'token',
                anthropicBaseUrl: 'https://api.example.test'
            },
            'sprites',
            '',
            {},
            { claudeVersion: '2.1.220' }
        )
        const adapter = new ClaudeCodeAdapter(
            handle.drivers as never,
            { updateFrameworkSessionRef: async () => undefined } as never
        )

        await drain(
            adapter.sendMessage(
                {
                    ...baseCtx,
                    framework: 'claude-code',
                    model: 'opus',
                    modelConfig: {
                        framework: 'claude-code',
                        model: 'opus',
                        effort,
                        modelMap: {
                            opus: 'anthropic/claude-opus-4-7'
                        }
                    }
                },
                userMessage
            )
        )

        const index = handle.request?.cmd.indexOf('--effort') ?? -1
        assert.notEqual(index, -1, effort)
        assert.equal(handle.request?.cmd[index + 1], effort)
    }
})

test('Claude adapter keeps 1M context on the CLI alias only', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                model: 'sonnet[1m]',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'sonnet[1m]',
                    effort: 'xhigh',
                    modelMap: {
                        sonnet: 'anthropic/claude-sonnet-x[1m]'
                    }
                }
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('sonnet[1m]'))
    assert.equal(
        handle.request?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
        'anthropic/claude-sonnet-x'
    )
})

test('Claude adapter pins selected provider model versions through family alias', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                model: 'anthropic/claude-opus-4-6',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'anthropic/claude-opus-4-6',
                    effort: 'xhigh',
                    modelMap: {
                        opus: 'anthropic/claude-opus-4-7'
                    }
                }
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('opus'))
    assert.equal(
        handle.request?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL,
        'anthropic/claude-opus-4-6'
    )
    const index = handle.request?.cmd.indexOf('--effort') ?? -1
    assert.notEqual(index, -1)
    assert.equal(handle.request?.cmd[index + 1], 'high')
})

test('Claude adapter emits raw_source for each stream JSONL row', async () => {
    const rawLine = JSON.stringify({
        uuid: 'asst-1',
        parentUuid: 'user-1',
        session_id: 'claude-session-1',
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }]
        }
    })
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'sprites',
        `${rawLine}\n`
    )
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )
    const events = await collect(
        adapter.sendMessage(
            { ...baseCtx, framework: 'claude-code' },
            userMessage
        )
    )

    const raw = events.find((event) => event.type === 'raw_source')
    assert.ok(raw)
    if (raw.type !== 'raw_source') throw new Error('unreachable')
    assert.equal(raw.source.rawFormat, 'jsonl')
    assert.equal(raw.source.rawText, rawLine)
    assert.equal(raw.source.sourceRef, 'claude-session-1')
    assert.equal(raw.source.parserName, 'claude-code-stream-json')
    assert.ok(events.some((event) => event.type === 'token'))
})

test('Claude daemon runtime-local turn does not inject platform credentials', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'daemon'
    )
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                runtimeKind: 'daemon'
            },
            userMessage
        )
    )

    assert.equal(handle.request?.env, undefined)
})

test('Claude runtime-local turn passes the picked model id through verbatim', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'daemon'
    )
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                runtimeKind: 'daemon',
                model: 'claude-sonnet-4-5',
                modelConfig: null
            },
            userMessage
        )
    )

    const cmd = handle.request?.cmd ?? []
    const modelIndex = cmd.indexOf('--model')
    assert.ok(modelIndex >= 0)
    // The platform path maps this onto the `sonnet` alias so the alias env can
    // repoint it; a local CLI has no such env and must get the id it was given.
    assert.equal(cmd[modelIndex + 1], 'claude-sonnet-4-5')
    assert.equal(handle.request?.env, undefined)
})

test('Claude runtime-local tuning sets effort without platform credentials', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'daemon'
    )
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                runtimeKind: 'daemon',
                model: 'claude-sonnet-4-5',
                modelConfig: null,
                runtimeLocalTuning: { effort: 'high' }
            },
            userMessage
        )
    )

    const cmd = handle.request?.cmd ?? []
    const effortIndex = cmd.indexOf('--effort')
    assert.ok(effortIndex >= 0)
    assert.equal(cmd[effortIndex + 1], 'high')
    assert.equal(handle.request?.env, undefined)
})

test('Claude sprites runtime-local turn does not inject platform credentials', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                modelConfig: null,
                runtimeLocalTuning: {}
            },
            userMessage
        )
    )

    // Injected env would outrank the sprite's on-disk sign-in — the exact
    // credential a runtime-local agent runs on.
    assert.equal(handle.request?.env, undefined)
})

test('Claude sprites platform turn still injects platform credentials', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'claude-sonnet-4-5',
                    modelMap: { sonnet: 'claude-sonnet-4-5' }
                }
            },
            userMessage
        )
    )

    assert.equal(handle.request?.env?.ANTHROPIC_AUTH_TOKEN, 'token')
    assert.equal(
        handle.request?.env?.ANTHROPIC_BASE_URL,
        'https://api.example.test'
    )
})

test('Claude sprites turn with neither config nor tuning keeps injecting', async () => {
    // The legacy no-modelConfigs chat fallback leaves modelConfig AND
    // runtimeLocalTuning null; those turns must keep today's injection.
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            { ...baseCtx, framework: 'claude-code', modelConfig: null },
            userMessage
        )
    )

    assert.equal(handle.request?.env?.ANTHROPIC_AUTH_TOKEN, 'token')
})

test('Claude platform config still maps a concrete model onto its alias', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'daemon'
    )
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                runtimeKind: 'daemon',
                model: 'claude-sonnet-4-5',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'claude-sonnet-4-5',
                    modelMap: { sonnet: 'claude-sonnet-4-5' }
                }
            },
            userMessage
        )
    )

    const cmd = handle.request?.cmd ?? []
    assert.equal(cmd[cmd.indexOf('--model') + 1], 'sonnet')
})

test('Claude daemon platform config injects saved platform provider', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'daemon'
    )
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                runtimeKind: 'daemon',
                model: 'sonnet',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'sonnet',
                    effort: 'high',
                    modelMap: {
                        sonnet: 'anthropic/claude-sonnet-x'
                    }
                }
            },
            userMessage
        )
    )

    assert.equal(handle.request?.env?.ANTHROPIC_AUTH_TOKEN, 'token')
    assert.equal(
        handle.request?.env?.ANTHROPIC_BASE_URL,
        'https://api.example.test'
    )
    assert.equal(
        handle.request?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
        'anthropic/claude-sonnet-x'
    )
})

// Managed Antigravity Claude reaches the same managed upstream group as Managed
// Antigravity but over anthropic_messages, so its base URL carries the
// `/antigravity` force-platform prefix. Nothing on the claude path may rewrite
// or strip it: the CLI has to POST {root}/antigravity/v1/messages.
test('Claude adapter passes a path-suffixed gateway base URL through verbatim', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://gateway.test/antigravity'
        },
        'daemon'
    )
    const adapter = new ClaudeCodeAdapter(handle.drivers as never, {} as never)

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                runtimeKind: 'daemon',
                model: 'opus',
                modelConfig: {
                    framework: 'claude-code',
                    model: 'opus',
                    effort: 'high',
                    modelMap: {
                        opus: 'claude-opus-4-6'
                    }
                }
            },
            userMessage
        )
    )

    assert.equal(
        handle.request?.env?.ANTHROPIC_BASE_URL,
        'https://gateway.test/antigravity'
    )
    assert.equal(
        handle.request?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL,
        'claude-opus-4-6'
    )
})

test('Codex adapter passes model override to CLI', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            { ...baseCtx, framework: 'codex', model: 'gpt-5.4' },
            userMessage
        )
    )

    assert.deepEqual(handle.request?.cmd.slice(0, 4), [
        'codex',
        'exec',
        '--skip-git-repo-check',
        '--json'
    ])
    assert.ok(
        handle.request?.cmd.includes(
            '--dangerously-bypass-approvals-and-sandbox'
        )
    )
    assert.ok(handle.request?.cmd.includes('--model'))
    assert.ok(handle.request?.cmd.includes('gpt-5.4'))
})

test('Codex adapter applies auto-review permission mode', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                codexPermissionMode: 'auto-review'
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('--sandbox'))
    assert.ok(handle.request?.cmd.includes('workspace-write'))
    assert.ok(handle.request?.cmd.includes('approval_policy="never"'))
})

test('Codex adapter applies full-access permission mode', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                codexPermissionMode: 'full-access'
            },
            userMessage
        )
    )

    assert.ok(
        handle.request?.cmd.includes(
            '--dangerously-bypass-approvals-and-sandbox'
        )
    )
})

test('Codex runtime-local tuning sets speed and effort without credentials', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' }, 'daemon')
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                runtimeKind: 'daemon',
                model: 'gpt-5.6-sol',
                modelConfig: null,
                runtimeLocalTuning: { speed: 'fast', intelligence: 'xhigh' }
            },
            userMessage
        )
    )

    const cmd = handle.request?.cmd ?? []
    assert.ok(cmd.includes('model_reasoning_effort="xhigh"'))
    assert.ok(cmd.includes('service_tier="fast"'))
    assert.equal(cmd[cmd.indexOf('--model') + 1], 'gpt-5.6-sol')
    // The tuning flags carry no credential, so the platform env must stay off.
    assert.equal(handle.request?.env, undefined)
})

test('Codex runtime-local turn without tuning leaves the local config alone', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' }, 'daemon')
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                runtimeKind: 'daemon',
                model: 'gpt-5.5',
                modelConfig: null,
                runtimeLocalTuning: { speed: null, intelligence: null }
            },
            userMessage
        )
    )

    const cmd = handle.request?.cmd ?? []
    assert.equal(
        cmd.some((arg) => arg.startsWith('model_reasoning_effort=')),
        false
    )
    assert.equal(
        cmd.some((arg) => arg.startsWith('service_tier=')),
        false
    )
})

test('Codex sprites runtime-local turn stays free of platform provider wiring', async () => {
    // Pins the "codex needs no adapter change" claim: sprites codex auth
    // lives in the sprite's ~/.codex/auth.json, and the only injection gate
    // is daemon+modelConfig — a runtime-local sprites turn must carry no env
    // and no Manyfold provider args.
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                model: 'gpt-5.5',
                modelConfig: null,
                runtimeLocalTuning: {}
            },
            userMessage
        )
    )

    const cmd = handle.request?.cmd ?? []
    assert.equal(handle.request?.env, undefined)
    assert.equal(
        cmd.some((arg) => arg.startsWith('model_provider=')),
        false
    )
})

test('Codex adapter resumes existing session ref', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                frameworkSessionRef: 'codex-session-1'
            },
            userMessage
        )
    )

    assert.deepEqual(handle.request?.cmd.slice(0, 5), [
        'codex',
        'exec',
        'resume',
        '--skip-git-repo-check',
        '--json'
    ])
    assert.equal(handle.request?.cmd.at(-2), 'codex-session-1')
    assert.equal(handle.request?.cmd.at(-1), '-')
    assert.equal(handle.request?.stdin, 'hello')
})

test('Codex adapter replays transcript when starting a fresh runtime session', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )
    const priorUser: ChatMessage = {
        id: 'msg-prior-user',
        sessionId: 'session-1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'old question' }],
        createdAt: new Date().toISOString()
    }
    const priorAssistant: ChatMessage = {
        id: 'msg-prior-assistant',
        sessionId: 'session-1',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'old answer' }],
        createdAt: new Date().toISOString()
    }

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                history: [priorUser, priorAssistant, userMessage]
            },
            userMessage
        )
    )

    const prompt = handle.request?.stdin ?? ''
    assert.equal(handle.request?.cmd[0], 'codex')
    assert.equal(handle.request?.cmd.at(-1), '-')
    assert.ok(!handle.request?.cmd.includes('resume'))
    assert.match(prompt, /fresh Codex runtime session/)
    assert.match(prompt, /<previous_transcript>/)
    assert.match(prompt, /<message role="user">\nold question/)
    assert.match(prompt, /<message role="assistant">\nold answer/)
    assert.match(prompt, /<latest_user_message>\nhello/)
})

test('Codex adapter applies auto-review permission mode when resuming', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                frameworkSessionRef: 'codex-session-1',
                codexPermissionMode: 'auto-review'
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('sandbox_mode="workspace-write"'))
    assert.ok(!handle.request?.cmd.includes('--sandbox'))
    assert.ok(handle.request?.cmd.includes('approval_policy="never"'))
})

test('Codex adapter passes intelligence and fast tier overrides', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                model: 'provider/gpt-5.5',
                modelConfig: {
                    framework: 'codex',
                    model: 'provider/gpt-5.5',
                    speed: 'fast',
                    intelligence: 'xhigh'
                }
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('model_reasoning_effort="xhigh"'))
    assert.ok(handle.request?.cmd.includes('service_tier="fast"'))
    assert.ok(handle.request?.cmd.includes('provider/gpt-5.5'))
})

test('Codex adapter emits raw_source for each exec JSON row', async () => {
    const rawLine = JSON.stringify({
        id: 'event-1',
        thread_id: 'thread-1',
        type: 'message',
        text: 'hello'
    })
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        `${rawLine}\n`
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        {} as never
    )
    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    const raw = events.find((event) => event.type === 'raw_source')
    assert.ok(raw)
    if (raw.type !== 'raw_source') throw new Error('unreachable')
    assert.equal(raw.source.rawFormat, 'jsonl')
    assert.equal(raw.source.rawText, rawLine)
    assert.equal(raw.source.sourceRef, 'thread-1')
    assert.equal(raw.source.parserName, 'codex-exec-json')
    assert.ok(events.some((event) => event.type === 'token'))
})

test('Codex adapter stores session_id as framework session ref', async () => {
    const rawLine = JSON.stringify({
        id: 'event-1',
        session_id: 'codex-session-1',
        type: 'message',
        text: 'hello'
    })
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        `${rawLine}\n`
    )
    let storedRef: string | null = null
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                storedRef = ref
            }
        } as never,
        {} as never
    )

    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    const raw = events.find((event) => event.type === 'raw_source')
    assert.ok(raw)
    if (raw.type !== 'raw_source') throw new Error('unreachable')
    assert.equal(raw.source.sourceRef, 'codex-session-1')
    assert.equal(storedRef, 'codex-session-1')
})

test('Codex adapter uses runtime-local inspected model as usage fallback', async () => {
    const rawLine = JSON.stringify({
        type: 'result',
        usage: {
            input_tokens: 10,
            output_tokens: 5
        }
    })
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        `${rawLine}\n`,
        {
            extras: {
                runtimeLocalModelConfig: {
                    framework: 'codex',
                    ready: true,
                    current: 'gpt-5.4 \u00b7 medium',
                    models: ['gpt-5.4', 'gpt-5.5']
                }
            }
        }
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        usagePricingMock as never
    )

    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    const usage = events.find((event) => event.type === 'usage')
    assert.ok(usage)
    if (usage.type !== 'usage') throw new Error('unreachable')
    assert.equal(usage.usage.model, 'gpt-5.4')
    assert.equal(usage.usage.isFallbackModel, true)
})

test('Codex adapter treats selected turn model as non-fallback usage model', async () => {
    const rawLine = JSON.stringify({
        type: 'turn.completed',
        usage: {
            input_tokens: 10,
            output_tokens: 5
        }
    })
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        `${rawLine}\n`
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        usagePricingMock as never
    )

    const events = await collect(
        adapter.sendMessage(
            { ...baseCtx, framework: 'codex', model: 'gpt-5.5' },
            userMessage
        )
    )

    const usage = events.find((event) => event.type === 'usage')
    assert.ok(usage)
    if (usage.type !== 'usage') throw new Error('unreachable')
    assert.equal(usage.usage.model, 'gpt-5.5')
    assert.equal(usage.usage.isFallbackModel, false)
})

test('Codex adapter trusts emitted usage model over runtime-local fallback', async () => {
    const rawLine = JSON.stringify({
        type: 'result',
        model: 'gpt-5.5',
        usage: {
            input_tokens: 10,
            output_tokens: 5
        }
    })
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        `${rawLine}\n`,
        {
            extras: {
                runtimeLocalModelConfig: {
                    framework: 'codex',
                    ready: true,
                    current: 'gpt-5.4 \u00b7 medium',
                    models: ['gpt-5.4', 'gpt-5.5']
                }
            }
        }
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        usagePricingMock as never
    )

    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    const usage = events.find((event) => event.type === 'usage')
    assert.ok(usage)
    if (usage.type !== 'usage') throw new Error('unreachable')
    assert.equal(usage.usage.model, 'gpt-5.5')
    assert.equal(usage.usage.isFallbackModel, false)
})

test('Codex adapter does not invent usage model when runtime-local cache is inconclusive', async () => {
    const rawLine = JSON.stringify({
        type: 'result',
        usage: {
            input_tokens: 10,
            output_tokens: 5
        }
    })
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        `${rawLine}\n`,
        {
            extras: {
                runtimeLocalModelConfig: {
                    framework: 'codex',
                    ready: true,
                    current: 'OPENAI_API_KEY env',
                    models: ['gpt-5.4', 'gpt-5.5']
                }
            }
        }
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        usagePricingMock as never
    )

    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    const usage = events.find((event) => event.type === 'usage')
    assert.ok(usage)
    if (usage.type !== 'usage') throw new Error('unreachable')
    assert.equal(usage.usage.model, null)
    assert.equal(usage.usage.isFallbackModel, false)
})

test('Codex daemon platform config injects saved platform provider', async () => {
    const handle = makeDriverFactory(
        {
            openaiApiKey: 'token',
            openaiBaseUrl: 'https://api.example.test'
        },
        'daemon'
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                runtimeKind: 'daemon',
                model: 'gpt-5.5',
                modelConfig: {
                    framework: 'codex',
                    model: 'gpt-5.5',
                    speed: 'fast',
                    intelligence: 'xhigh'
                }
            },
            userMessage
        )
    )

    assert.equal(handle.request?.env?.OPENAI_API_KEY, 'token')
    assert.ok(handle.request?.cmd.includes('model_provider="Manyfold"'))
    assert.ok(
        handle.request?.cmd.includes(
            'model_providers.Manyfold.base_url="https://api.example.test"'
        )
    )
    assert.ok(
        handle.request?.cmd.includes(
            'model_providers.Manyfold.env_key="OPENAI_API_KEY"'
        )
    )
})

test('Gemini adapter prefers model override over saved credential model', async () => {
    const handle = makeDriverFactory({
        googleApiKey: 'token',
        model: 'gemini-2.5-flash'
    })
    const adapter = new GeminiCliAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'gemini-cli',
                model: 'gemini-2.5-pro',
                modelOverride: 'gemini-2.5-pro'
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('--model'))
    assert.ok(handle.request?.cmd.includes('gemini-2.5-pro'))
    const approvalIndex = handle.request?.cmd.indexOf('--approval-mode') ?? -1
    assert.notEqual(approvalIndex, -1)
    assert.equal(handle.request?.cmd[approvalIndex + 1], 'yolo')
    const launcher = handle.request?.cmd[2] ?? ''
    assert.match(launcher, /GEMINI_CLI_TRUST_WORKSPACE=true/)
    assert.match(launcher, /GEMINI_API_KEY:-/)
    assert.match(launcher, /selectedType = 'gemini-api-key'/)
    assert.equal(handle.request?.env?.GEMINI_MODEL, 'gemini-2.5-pro')
    assert.equal(handle.request?.timeoutMs, EXEC_TIMEOUTS.timeoutMs)
    assert.equal(handle.request?.keepAliveMs, EXEC_TIMEOUTS.keepAliveMs)
    assert.equal(
        handle.request?.livenessTimeoutMs,
        EXEC_TIMEOUTS.livenessTimeoutMs
    )
})

test('Gemini daemon adapter does not require stored credentials', async () => {
    const handle = makeDriverFactory(null, 'daemon')
    const adapter = new GeminiCliAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'gemini-cli',
                runtimeKind: 'daemon',
                model: 'gemini-2.5-pro'
            },
            userMessage
        )
    )

    assert.ok(handle.request?.cmd.includes('--model'))
    assert.ok(handle.request?.cmd.includes('gemini-2.5-pro'))
    const approvalIndex = handle.request?.cmd.indexOf('--approval-mode') ?? -1
    assert.notEqual(approvalIndex, -1)
    assert.equal(handle.request?.cmd[approvalIndex + 1], 'yolo')
    assert.equal(handle.request?.env, undefined)
})

test('Gemini sprites runtime-local turn does not inject platform credentials', async () => {
    const handle = makeDriverFactory({
        googleApiKey: 'token',
        model: 'gemini-2.5-flash'
    })
    const adapter = new GeminiCliAdapter(
        handle.drivers as never,
        {} as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'gemini-cli',
                modelConfig: null,
                runtimeLocalTuning: {}
            },
            userMessage
        )
    )

    // No GEMINI_API_KEY also means the bash bootstrap skips its
    // settings.json rewrite, so the user's own auth selection survives; and
    // the stored credential's model must not leak into the turn.
    assert.equal(handle.request?.env, undefined)
    assert.equal(handle.request?.cmd.includes('--model'), false)
})

test('Gemini adapter keeps auto routing off the CLI flags and bills result stats', async () => {
    const resultLine = JSON.stringify({
        type: 'result',
        status: 'success',
        stats: {
            total_tokens: 120,
            input_tokens: 100,
            output_tokens: 20,
            cached: 0,
            input: 100,
            duration_ms: 42,
            tool_calls: 0,
            models: {
                'gemini-2.5-flash': {
                    total_tokens: 120,
                    input_tokens: 100,
                    output_tokens: 20,
                    cached: 0,
                    input: 100
                }
            }
        }
    })
    const handle = makeDriverFactory(
        { googleApiKey: 'token' },
        'sprites',
        `${resultLine}\n`
    )
    const adapter = new GeminiCliAdapter(
        handle.drivers as never,
        {} as never,
        {
            computeCost: () => ({ costUsd: null, costSource: 'unknown' })
        } as never
    )

    const events = await collect(
        adapter.sendMessage(
            { ...baseCtx, framework: 'gemini-cli', model: 'auto' },
            userMessage
        )
    )

    assert.ok(!handle.request?.cmd.includes('--model'))
    assert.equal(handle.request?.env?.GEMINI_MODEL, undefined)
    const usage = events.find((event) => event.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    assert.equal(usage.usage.model, 'gemini-2.5-flash')
    assert.equal(usage.usage.inputTokens, 100)
    assert.equal(usage.usage.outputTokens, 20)
})

test('Codex adapter sends the prompt via stdin with a "-" positional', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' })
    const adapter = new CodexAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        {} as never
    )

    await drain(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    assert.equal(handle.request?.cmd.at(-1), '-')
    assert.equal(handle.request?.stdin, 'hello')
    assert.ok(!handle.request?.cmd.includes('hello'))
    assert.equal(handle.request?.timeoutMs, EXEC_TIMEOUTS.timeoutMs)
    assert.equal(handle.request?.keepAliveMs, EXEC_TIMEOUTS.keepAliveMs)
    assert.equal(
        handle.request?.livenessTimeoutMs,
        EXEC_TIMEOUTS.livenessTimeoutMs
    )
})

test('Claude adapter sends the prompt via stdin instead of argv', async () => {
    const handle = makeDriverFactory({
        anthropicAuthToken: 'token',
        anthropicBaseUrl: 'https://api.example.test'
    })
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )

    await drain(
        adapter.sendMessage(
            { ...baseCtx, framework: 'claude-code' },
            userMessage
        )
    )

    assert.equal(handle.request?.stdin, 'hello')
    assert.ok(!handle.request?.cmd.includes('hello'))
    assert.equal(handle.request?.timeoutMs, EXEC_TIMEOUTS.timeoutMs)
    assert.equal(handle.request?.keepAliveMs, EXEC_TIMEOUTS.keepAliveMs)
    assert.equal(
        handle.request?.livenessTimeoutMs,
        EXEC_TIMEOUTS.livenessTimeoutMs
    )
})

test('Claude adapter on daemon runtime puts the prompt on argv, not stdin', async () => {
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'daemon'
    )
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )

    await drain(
        adapter.sendMessage(
            { ...baseCtx, framework: 'claude-code', runtimeKind: 'daemon' },
            userMessage
        )
    )

    assert.equal(handle.request?.cmd.at(-1), 'hello')
    assert.equal(handle.request?.stdin, '')
})

test('Codex adapter on daemon runtime puts the prompt on argv, not stdin', async () => {
    const handle = makeDriverFactory({ openaiApiKey: 'token' }, 'daemon')
    const adapter = new CodexAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        {} as never
    )

    await drain(
        adapter.sendMessage(
            { ...baseCtx, framework: 'codex', runtimeKind: 'daemon' },
            userMessage
        )
    )

    assert.equal(handle.request?.cmd.at(-1), 'hello')
    assert.ok(!handle.request?.cmd.includes('-'))
    assert.equal(handle.request?.stdin, '')
})

test('Codex adapter persists the session ref before a mid-stream failure', async () => {
    const rawLine = JSON.stringify({
        id: 'event-1',
        thread_id: 'thread-1',
        type: 'item.started'
    })
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        `${rawLine}\n`,
        {},
        { failMidStream: true }
    )
    const stored: (string | null)[] = []
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never,
        {} as never
    )

    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    assert.ok(stored.includes('thread-1'))
    assert.ok(events.some((event) => event.type === 'error'))
    assert.ok(!events.some((event) => event.type === 'done'))
})

test('Claude adapter persists the session ref before a mid-stream failure', async () => {
    const rawLine = JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }]
        }
    })
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'sprites',
        `${rawLine}\n`,
        {},
        { failMidStream: true }
    )
    const stored: (string | null)[] = []
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never
    )

    const events = await collect(
        adapter.sendMessage(
            { ...baseCtx, framework: 'claude-code' },
            userMessage
        )
    )

    assert.ok(stored.includes('claude-session-1'))
    assert.ok(events.some((event) => event.type === 'error'))
    assert.ok(!events.some((event) => event.type === 'done'))
})

test('Gemini adapter persists the session ref before a mid-stream failure', async () => {
    const rawLine = JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'hi',
        session_id: 'gemini-session-1'
    })
    const handle = makeDriverFactory(
        { googleApiKey: 'token', model: 'gemini-2.5-pro' },
        'sprites',
        `${rawLine}\n`,
        {},
        { failMidStream: true }
    )
    const stored: (string | null)[] = []
    const adapter = new GeminiCliAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never,
        {} as never
    )

    const events = await collect(
        adapter.sendMessage(
            { ...baseCtx, framework: 'gemini-cli' },
            userMessage
        )
    )

    assert.ok(stored.includes('gemini-session-1'))
    assert.ok(events.some((event) => event.type === 'error'))
    assert.ok(!events.some((event) => event.type === 'done'))
})

test('Claude adapter clears the frozen session ref when --resume cannot load the session', async () => {
    const resultLine = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 0,
        duration_ms: 0,
        session_id: 'dead-session',
        usage: { input_tokens: 0, output_tokens: 0 }
    })
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'sprites',
        `${resultLine}\n`
    )
    const stored: (string | null)[] = []
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never
    )

    const events = await collect(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                frameworkSessionRef: 'dead-session'
            },
            userMessage
        )
    )

    assert.ok(events.some((event) => event.type === 'error'))
    assert.deepEqual(stored, [null])
})

test('Claude adapter keeps the session ref when an in-turn error is not a resume load failure', async () => {
    const resultLine = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 2,
        session_id: 'live-session',
        usage: { input_tokens: 5, output_tokens: 5 }
    })
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'sprites',
        `${resultLine}\n`
    )
    const stored: (string | null)[] = []
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never
    )

    await collect(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                frameworkSessionRef: 'live-session'
            },
            userMessage
        )
    )

    assert.ok(!stored.includes(null))
})

test('Claude adapter keeps the session ref when a resume error omits num_turns', async () => {
    const resultLine = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        // num_turns intentionally absent — must NOT be coerced to 0 / treated as a
        // load failure, since a transient/upstream error can lack the field
        session_id: 'keep-session',
        usage: { input_tokens: 1, output_tokens: 0 }
    })
    const handle = makeDriverFactory(
        {
            anthropicAuthToken: 'token',
            anthropicBaseUrl: 'https://api.example.test'
        },
        'sprites',
        `${resultLine}\n`
    )
    const stored: (string | null)[] = []
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never
    )

    await collect(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'claude-code',
                frameworkSessionRef: 'keep-session'
            },
            userMessage
        )
    )

    assert.ok(!stored.includes(null))
})

test('Codex adapter clears the frozen session ref when resume rollout is missing', async () => {
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        '',
        {},
        {
            exitCode: 1,
            stderr: 'Error: thread/resume failed: no rollout found for thread id dead-thread'
        }
    )
    const stored: (string | null)[] = []
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never,
        {} as never
    )

    const events = await collect(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                frameworkSessionRef: 'dead-thread'
            },
            userMessage
        )
    )

    assert.ok(events.some((event) => event.type === 'error'))
    assert.deepEqual(stored, [null])
})

test('Codex adapter keeps the session ref on a non-resume exec failure', async () => {
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        '',
        {},
        { exitCode: 1, stderr: 'some unrelated runtime error' }
    )
    const stored: (string | null)[] = []
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never,
        {} as never
    )

    await collect(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                frameworkSessionRef: 'live-thread'
            },
            userMessage
        )
    )

    assert.ok(!stored.includes(null))
})

test('Codex adapter surfaces the stdout turn.failed reason when codex exits non-zero with empty stderr', async () => {
    const stdout =
        '{"type":"turn.started"}\n' +
        '{"type":"error","message":"unexpected status 401 Unauthorized INVALID_API_KEY"}\n' +
        '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized INVALID_API_KEY"}}\n'
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        stdout,
        {},
        { exitCode: 1, stderr: '' }
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        {} as never
    )

    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )

    const errorEvent = events.find(
        (event): event is Extract<EmittedChatEvent, { type: 'error' }> =>
            event.type === 'error'
    )
    assert.ok(errorEvent, 'expected an error event')
    assert.equal(errorEvent.error.code, 'codex_exec_failed')
    assert.match(errorEvent.error.message, /codex exited 1/)
    assert.match(errorEvent.error.message, /INVALID_API_KEY/)
    assert.equal(errorEvent.managedChannelFailure, undefined)
})

test('Codex adapter marks only an owned structured 503 pool exhaustion', async () => {
    const detail =
        'unexpected status 503 Service Unavailable: {"error":{"message":"No available accounts: no available accounts"}}'
    const stdout = `${JSON.stringify({ type: 'turn.failed', error: { message: detail } })}\n`
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        stdout,
        {},
        { exitCode: 1, stderr: '' }
    )
    const adapter = new CodexAdapter(
        handle.drivers as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        {} as never
    )

    const events = await collect(
        adapter.sendMessage({ ...baseCtx, framework: 'codex' }, userMessage)
    )
    const errorEvent = events.find(
        (event): event is Extract<EmittedChatEvent, { type: 'error' }> =>
            event.type === 'error'
    )

    assert.ok(errorEvent)
    assert.equal(errorEvent.managedChannelFailure, 'account_pool_empty')
})

test('Codex adapter self-heals when the resume rollout failure is reported on stdout', async () => {
    const stdout =
        '{"type":"turn.failed","error":{"message":"thread/resume failed: no rollout found for thread id dead-thread"}}\n'
    const handle = makeDriverFactory(
        { openaiApiKey: 'token' },
        'sprites',
        stdout,
        {},
        { exitCode: 1, stderr: '' }
    )
    const stored: (string | null)[] = []
    const adapter = new CodexAdapter(
        handle.drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                stored.push(ref)
            }
        } as never,
        {} as never
    )

    await collect(
        adapter.sendMessage(
            {
                ...baseCtx,
                framework: 'codex',
                frameworkSessionRef: 'dead-thread'
            },
            userMessage
        )
    )

    assert.deepEqual(stored, [null])
})

const makeDriverFactory = (
    creds: unknown,
    runtime: 'sprites' | 'k8s' | 'daemon' = 'sprites',
    stdout = '',
    agent: Record<string, unknown> = {},
    opts: {
        failMidStream?: boolean
        exitCode?: number
        stderr?: string
        claudeVersion?: string | null
        claudeVersionExitCode?: number
    } = {}
): {
    drivers: { forAgent: () => Promise<unknown> }
    request: ExecStreamRequest | null
    requests: ExecStreamRequest[]
} => {
    const out: {
        drivers: { forAgent: () => Promise<unknown> }
        request: ExecStreamRequest | null
        requests: ExecStreamRequest[]
    } = {
        request: null,
        requests: [],
        drivers: {
            forAgent: async () => ({
                driver,
                creds,
                runtime,
                agent: { workspacePath: '/workspace', ...agent }
            })
        }
    }
    const driver: ExecDriver = {
        stream: (request) => {
            out.request = request
            out.requests.push(request)
            const versionProbe =
                request.cmd.length === 2 &&
                request.cmd[0] === 'claude' &&
                request.cmd[1] === '--version'
            const streamStdout = versionProbe
                ? opts.claudeVersion === null
                    ? ''
                    : `${opts.claudeVersion ?? '2.1.220'} (Claude Code)\n`
                : stdout
            const streamStderr = versionProbe ? '' : (opts.stderr ?? '')
            return {
                stdout: opts.failMidStream
                    ? failingChunks(streamStdout)
                    : chunks(streamStdout),
                stderr: chunks(streamStderr),
                result: Promise.resolve({
                    exitCode: versionProbe
                        ? (opts.claudeVersionExitCode ?? 0)
                        : (opts.exitCode ?? 0),
                    stdout: streamStdout,
                    stderr: streamStderr
                }),
                abort: () => {}
            }
        }
    }
    return out
}

const usagePricingMock = {
    computeCost: () => ({ costUsd: null, costSource: 'unknown' as const })
}

const chunks = async function* (...values: string[]): AsyncIterable<string> {
    for (const value of values) yield value
}

const failingChunks = async function* (line: string): AsyncIterable<string> {
    if (line) yield line
    throw new Error('execSpriteStream idle for 180000ms')
}

const drain = async (events: AsyncIterable<unknown>): Promise<void> => {
    for await (const event of events) void event
}

const collect = async (
    events: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const event of events) out.push(event)
    return out
}
