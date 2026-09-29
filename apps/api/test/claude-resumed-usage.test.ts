import type { ChatMessage, ChatUsage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import type {
    ExecDriver,
    ExecStreamRequest
} from '../src/modules/chat/adapters/exec-driver'
import {
    UsagePricingEngine,
    type UsagePricingService
} from '../src/modules/usage/usage-pricing.service'
import { LITELLM_PRICING_SAMPLE } from './litellm-pricing-sample'

// A turn that resumes a session reports the session's running cost totals
// (Claude Code 2.1.277 on); the usage the adapter emits is the turn's own.

const pricing = new UsagePricingEngine({
    fetchPricing: async () => ({ raw: null, etag: null }),
    fetchModelsDev: async () => ({ raw: null, etag: null }),
    fetchNetmind: async () => ({ raw: null, etag: null }),
    loadSnapshot: async (source) =>
        source === 'litellm'
            ? {
                  prices: LITELLM_PRICING_SAMPLE,
                  etag: null,
                  fetchedAt: new Date()
              }
            : null,
    ttlMs: Number.POSITIVE_INFINITY
})

before(() => pricing.ensureLoaded())

const userMessage: ChatMessage = {
    id: 'msg-user',
    sessionId: 'session-1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'who are you?' }],
    createdAt: new Date().toISOString()
}

const ctx = (frameworkSessionRef: string | null): ApiChatAdapterContext => ({
    userId: 'user-1',
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    sessionId: 'session-1',
    messageId: 'msg-assistant',
    framework: 'claude-code',
    runtimeKind: 'sprites',
    model: 'haiku',
    modelOverride: null,
    modelConfig: {
        framework: 'claude-code',
        model: 'haiku',
        modelMap: {
            sonnet: 'claude-sonnet-5',
            haiku: 'claude-haiku-4-5-20251001'
        }
    },
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
    openclawPermissionMode: null,
    frameworkSessionRef,
    history: []
})

// Seen on a local stack [2026-09-29]: the session's first turn ran on
// Sonnet; this one, after the switch to Haiku, resumed it.
const stdout = [
    {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'claude-haiku-4-5-20251001',
        claude_code_version: '2.1.285'
    },
    {
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: {
            id: 'msg_1',
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'text', text: 'I am Claude Haiku 4.5.' }]
        }
    },
    {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        is_error: false,
        total_cost_usd: 0.12682025,
        usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 29593,
            cache_read_input_tokens: 0,
            output_tokens: 122
        },
        modelUsage: {
            'claude-sonnet-5': { costUSD: 0.089209 },
            'claude-haiku-4-5-20251001': { costUSD: 0.03761125 }
        }
    }
]
    .map((line) => JSON.stringify(line))
    .join('\n')

const run = async (
    frameworkSessionRef: string | null
): Promise<{ usage: ChatUsage | null; request: ExecStreamRequest | null }> => {
    let request: ExecStreamRequest | null = null
    const driver: ExecDriver = {
        stream: (req) => {
            request = req
            return {
                stdout: (async function* () {
                    yield `${stdout}\n`
                })(),
                stderr: (async function* () {})(),
                result: Promise.resolve({ exitCode: 0, stdout, stderr: '' }),
                abort: () => {}
            }
        }
    }
    const adapter = new ClaudeCodeAdapter(
        {
            forAgent: async () => ({
                driver,
                creds: {
                    anthropicAuthToken: 'token',
                    anthropicBaseUrl: 'https://api.example.test'
                },
                runtime: 'sprites',
                agent: { workspacePath: '/workspace' }
            })
        } as never,
        { updateFrameworkSessionRef: async () => undefined } as never,
        {
            isFeatureEnabled: async () => false,
            getCachedChatExecTimeoutMs: async () => ({
                keepAliveMs: 20_000,
                livenessTimeoutMs: 75_000,
                timeoutMs: 7_200_000
            })
        } as never,
        undefined,
        pricing as unknown as UsagePricingService
    )
    const events: EmittedChatEvent[] = []
    for await (const event of adapter.sendMessage(
        ctx(frameworkSessionRef),
        userMessage
    ))
        events.push(event)
    const usage = events.find((event) => event.type === 'usage')
    return {
        usage: usage?.type === 'usage' ? usage.usage : null,
        request
    }
}

test('a resumed turn is recorded on its own model and cost', async () => {
    const { usage, request } = await run('sess-1')
    assert.ok(request?.cmd.includes('--resume'))
    assert.equal(usage?.model, 'claude-haiku-4-5-20251001')
    assert.equal(usage?.costUsd, 0.037611)
    assert.equal(usage?.costSource, 'table')
})

test("a session's first turn keeps the cost Claude Code reports", async () => {
    const { usage, request } = await run(null)
    assert.equal(request?.cmd.includes('--resume'), false)
    assert.equal(usage?.model, 'claude-haiku-4-5-20251001')
    assert.equal(usage?.costUsd, 0.12682025)
    assert.equal(usage?.costSource, 'upstream')
})
