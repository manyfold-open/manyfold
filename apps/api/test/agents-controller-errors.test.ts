import assert from 'node:assert/strict'
import test from 'node:test'
import { InternalServerErrorException } from '@nestjs/common'
import {
    classifyError,
    sanitizeMessage
} from '../src/modules/agents/create-stream'

test('classifyError preserves orchestrator errorClass from HTTP exception response', () => {
    const err = new InternalServerErrorException({
        message: 'claude --print returned is_error=true',
        errorClass: 'bootstrap:claude-verify'
    })

    assert.equal(classifyError(err), 'bootstrap:claude-verify')
})

test('sanitizeMessage reads HTTP exception response message', () => {
    const err = new InternalServerErrorException({
        message: 'claude --print returned is_error=true: failed',
        errorClass: 'bootstrap:claude-verify'
    })

    assert.equal(
        sanitizeMessage(err),
        'claude --print returned is_error=true: failed'
    )
})

// A create that fails after the 201 reports as an event, which carried only
// the exception class and message: a CLI could not tell RUNTIME_LIMIT_REACHED
// from any other 403, nor show the limit.
test('the stream error event carries the code, status and details a response would', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    const { streamAgentCreate } =
        await import('../src/modules/agents/create-stream')
    const calls: string[] = []
    const lines: string[] = []
    const res = {
        hijack: () => calls.push('hijack'),
        request: { headers: {} },
        raw: {
            writeHead: (status: number) => calls.push(`writeHead ${status}`),
            write: (chunk: string) => lines.push(chunk),
            end: () => calls.push('end')
        }
    }
    await streamAgentCreate({
        res: res as never,
        framework: 'codex',
        plan: { runtime: 'sprites', steps: ['validating', 'checking_quota'] },
        log: { warn: () => {} } as never,
        run: async (emitter) => {
            emitter.step('validating')
            emitter.step('checking_quota')
            throw new ForbiddenException({
                message: 'Stateful sandbox limit reached (3 for Free plan)',
                code: 'RUNTIME_LIMIT_REACHED',
                limit: 3,
                details: {
                    kind: 'sprites',
                    current: 3,
                    limit: 3,
                    planName: 'Free'
                }
            })
        }
    })

    assert.deepEqual(calls, ['hijack', 'writeHead 201', 'end'])
    const events = lines.map((line) => JSON.parse(line))
    assert.deepEqual(
        events.map((e) => e.type),
        ['step', 'step', 'error']
    )
    assert.deepEqual(events[2], {
        type: 'error',
        step: 'checking_quota',
        errorClass: 'ForbiddenException',
        message: 'Stateful sandbox limit reached (3 for Free plan)',
        code: 'RUNTIME_LIMIT_REACHED',
        status: 403,
        details: { kind: 'sprites', current: 3, limit: 3, planName: 'Free' }
    })
})

test('a failure that is not an HTTP error streams as internal_error', async () => {
    const { errorEventFields } =
        await import('../src/modules/agents/create-stream')
    assert.deepEqual(errorEventFields(new Error('boom')), {
        code: 'internal_error',
        status: 500
    })
})

// Resolving the runtime used to run after res.hijack(), where a thrown error
// reached the exception filter with no way left to answer: the request hung.
// The plan is now resolved first, so it fails as an ordinary HTTP error.
test('the stream plan is resolved without the reply, and routes runtimeId to k8s', async () => {
    const { ConflictException } = await import('@nestjs/common')
    const { resolveCreateStreamPlan } =
        await import('../src/modules/agents/create-stream')
    const noSettings = {
        adminSettings: {
            getCachedFrameworkRuntimeDefaults: async () => {
                throw new Error('a runtimeId create must not read defaults')
            }
        },
        users: {
            getFrameworkRuntimeOverrides: async () => {
                throw new Error('a runtimeId create must not read overrides')
            }
        }
    }
    const k8s = await resolveCreateStreamPlan(noSettings as never, 'user-1', {
        name: 'x',
        framework: 'claude-code',
        runtimeId: 'art_1'
    } as never)
    assert.equal(k8s.runtime, 'k8s')

    const settings = {
        adminSettings: {
            getCachedFrameworkRuntimeDefaults: async () => ({ defaults: {} })
        },
        users: {
            getFrameworkRuntimeOverrides: async () => ({ overrides: {} })
        }
    }
    await assert.rejects(
        () =>
            resolveCreateStreamPlan(settings as never, 'user-1', {
                name: 'x',
                framework: 'openclaw'
            } as never),
        (err) => err instanceof ConflictException
    )
})
