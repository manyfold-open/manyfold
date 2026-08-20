import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ApiChatAdapterContext } from '../src/modules/chat/chat-adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ExecDriver,
    ExecStreamRequest
} from '../src/modules/chat/adapters/exec-driver'

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
    framework: 'gemini-cli',
    runtimeKind: 'sprites',
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    frameworkSessionRef: null,
    history: []
}

const chunks = async function* (...values: string[]): AsyncIterable<string> {
    for (const value of values) yield value
}

const captureLaunch = async (
    creds: Record<string, unknown>,
    model: string | null
): Promise<ExecStreamRequest> => {
    let request: ExecStreamRequest | null = null
    const driver: ExecDriver = {
        stream: (req) => {
            request = req
            return {
                stdout: chunks(''),
                stderr: chunks(''),
                result: Promise.resolve({
                    exitCode: 0,
                    stdout: '',
                    stderr: ''
                }),
                abort: () => {}
            }
        }
    }
    const drivers = {
        forAgent: async () => ({
            driver,
            creds,
            runtime: 'sprites',
            agent: { workspacePath: '/workspace' }
        })
    }
    const adapter = new GeminiCliAdapter(
        drivers as never,
        {} as never,
        {} as never
    )
    const events = adapter.sendMessage(
        { ...baseCtx, model, modelOverride: model },
        userMessage
    )
    for await (const event of events) void event
    assert.ok(request)
    return request
}

// Runs the launcher exactly as the sprite would: same bash script, same env,
// with a stub `gemini` binary so the trailing exec succeeds.
const runLauncher = async (
    request: ExecStreamRequest,
    seedSettings?: Record<string, unknown>
): Promise<Record<string, any>> => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'mf-gemini-settings-'))
    const binDir = path.join(home, '.local', 'bin')
    mkdirSync(binDir, { recursive: true })
    const stub = path.join(binDir, 'gemini')
    writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    if (seedSettings) {
        mkdirSync(path.join(home, '.gemini'), { recursive: true })
        writeFileSync(
            path.join(home, '.gemini', 'settings.json'),
            JSON.stringify(seedSettings, null, 2)
        )
    }
    const launcher = request.cmd[2]
    assert.ok(launcher.includes('MF_GEMINI_SETTINGS'))
    const run = spawnSync(
        'bash',
        ['-c', launcher, 'gemini', '--output-format', 'stream-json'],
        {
            // The sprite variant re-attaches the prompt from stdin
            // (MF_PROMPT="$(cat)"), so stdin must be provided and closed.
            input: '',
            encoding: 'utf8',
            env: {
                ...request.env,
                HOME: home,
                PATH: process.env.PATH ?? ''
            }
        }
    )
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(
        readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')
    ) as Record<string, any>
}

test('gemini launcher pins gateway turns to the selected model', async () => {
    const request = await captureLaunch(
        {
            googleApiKey: 'sk-live',
            // Trailing slash exercises the base-url normalization.
            googleGeminiBaseUrl: 'https://gateway.test/antigravity/'
        },
        'gemini-3.5-flash-low'
    )
    assert.equal(request.env?.GEMINI_MODEL, 'gemini-3.5-flash-low')

    const settings = await runLauncher(request, {
        mcpServers: { probe: { command: 'noop' } }
    })

    assert.equal(settings.security.auth.selectedType, 'gemini-api-key')
    assert.equal(settings.experimental.dynamicModelConfiguration, true)
    assert.deepEqual(settings.modelConfigs.modelIdResolutions, {
        'gemini-3.5-flash-low': {
            default: 'gemini-3.5-flash-low',
            contexts: []
        }
    })
    const overrides = settings.modelConfigs.customOverrides as Array<{
        match: { model: string }
        modelConfig: { model: string }
    }>
    assert.ok(overrides.length > 0)
    for (const override of overrides) {
        assert.equal(override.modelConfig.model, 'gemini-3.5-flash-low')
    }
    const targets = overrides.map((o) => o.match.model)
    for (const expected of [
        'gemini-3-flash-base',
        'chat-compression-default',
        'gemini-3-flash-preview',
        'gemini-3-pro-preview',
        'gemini-3.1-flash-lite',
        'classifier'
    ]) {
        assert.ok(targets.includes(expected), `missing override ${expected}`)
    }
    // Foreign keys (MCP config shares this file) survive the rewrite.
    assert.deepEqual(settings.mcpServers, { probe: { command: 'noop' } })
})

test('gemini launcher removes stale gateway overrides on the official endpoint', async () => {
    const request = await captureLaunch(
        {
            googleApiKey: 'sk-live',
            googleGeminiBaseUrl: 'https://generativelanguage.googleapis.com'
        },
        'gemini-2.5-pro'
    )

    const settings = await runLauncher(request, {
        mcpServers: { probe: { command: 'noop' } },
        experimental: { dynamicModelConfiguration: true, other: true },
        modelConfigs: {
            modelIdResolutions: { stale: { default: 'stale' } },
            customOverrides: [
                { match: { model: 'base' }, modelConfig: { model: 'stale' } }
            ]
        }
    })

    assert.equal(settings.security.auth.selectedType, 'gemini-api-key')
    assert.equal(settings.experimental?.dynamicModelConfiguration, undefined)
    // Keys we do not own survive; empty sections disappear entirely.
    assert.equal(settings.experimental?.other, true)
    assert.equal(settings.modelConfigs, undefined)
    assert.deepEqual(settings.mcpServers, { probe: { command: 'noop' } })
})

test('gemini launcher skips neutralization when no model is pinned', async () => {
    const request = await captureLaunch(
        {
            googleApiKey: 'sk-live',
            googleGeminiBaseUrl: 'https://gateway.test/antigravity'
        },
        null
    )
    assert.equal(request.env?.GEMINI_MODEL, undefined)

    const settings = await runLauncher(request)

    assert.equal(settings.security.auth.selectedType, 'gemini-api-key')
    assert.equal(settings.experimental, undefined)
    assert.equal(settings.modelConfigs, undefined)
})
