import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { REQUIRED_API_TOKEN_SCOPES_META } from '../src/common/decorators/require-api-token-scope.decorator'
import { SUBJECT_AGENT_META } from '../src/common/decorators/subject-agent.decorator'
import { AgentRuntimesController } from '../src/modules/agent-runtimes/agent-runtimes.controller'
import { AgentsController } from '../src/modules/agents/agents.controller'
import { FilesController } from '../src/modules/agents/files/files.controller'
import { RuntimeAgentsController } from '../src/modules/agents/runtime-agents.controller'
import { AutomationsController } from '../src/modules/automations/automations.controller'
import { BackupsController } from '../src/modules/backups/backups.controller'
import { ChannelsController } from '../src/modules/channels/channels.controller'
import { ChatController } from '../src/modules/chat/chat.controller'
import { ChatUploadsController } from '../src/modules/chat/uploads/chat-uploads.controller'
import { ModelProvidersController } from '../src/modules/model-providers/model-providers.controller'
import { OpenAiChatCompletionsController } from '../src/modules/openai-compat/openai-chat-completions.controller'
import { LibrarySkillsController } from '../src/modules/skills/library-skills.controller'
import { SkillsController } from '../src/modules/skills/skills.controller'
import { UsageController } from '../src/modules/usage/usage.controller'
import { UserExternalAgentProvidersController } from '../src/modules/user-external-agent-providers/user-external-agent-providers.controller'

// Every controller that uses @RequireApiTokenScope on a method must ALSO
// declare a subject-agent classification on that method (or be allowlisted
// via @AllowBoundTokenWithoutSubject). This prevents bound-token leaks when
// new endpoints are added without considering per-agent enforcement.
const controllers: ReadonlyArray<new (...args: never[]) => object> = [
    AgentsController,
    AgentRuntimesController,
    AutomationsController,
    BackupsController,
    ChannelsController,
    ChatController,
    ChatUploadsController,
    FilesController,
    ModelProvidersController,
    OpenAiChatCompletionsController,
    RuntimeAgentsController,
    LibrarySkillsController,
    SkillsController,
    UsageController,
    UserExternalAgentProvidersController
]

const collectScopedMethods = (
    ctor: new (...args: never[]) => object
): Array<{ className: string; method: string }> => {
    const proto = ctor.prototype as Record<string, unknown>
    const out: Array<{ className: string; method: string }> = []
    for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue
        const fn = proto[name]
        if (typeof fn !== 'function') continue
        const scopes = Reflect.getMetadata(
            REQUIRED_API_TOKEN_SCOPES_META,
            fn
        )
        if (!scopes) continue
        out.push({ className: ctor.name, method: name })
    }
    return out
}

test('every @RequireApiTokenScope method declares a subject-agent classification', () => {
    const missing: Array<{ className: string; method: string }> = []
    for (const ctor of controllers) {
        for (const entry of collectScopedMethods(ctor)) {
            const fn = (ctor.prototype as Record<string, unknown>)[
                entry.method
            ] as (...args: unknown[]) => unknown
            const classification = Reflect.getMetadata(SUBJECT_AGENT_META, fn)
            if (!classification) missing.push(entry)
        }
    }
    assert.deepEqual(
        missing,
        [],
        `controllers missing SUBJECT_AGENT_META on scoped methods: ${JSON.stringify(missing)}`
    )
})

test('allowlisted classifications include a non-empty reason', () => {
    const violations: Array<{
        className: string
        method: string
        reason: unknown
    }> = []
    for (const ctor of controllers) {
        for (const entry of collectScopedMethods(ctor)) {
            const fn = (ctor.prototype as Record<string, unknown>)[
                entry.method
            ] as (...args: unknown[]) => unknown
            const classification = Reflect.getMetadata(
                SUBJECT_AGENT_META,
                fn
            ) as { type?: string; reason?: unknown } | undefined
            if (classification?.type === 'allowlisted') {
                const reason = classification.reason
                if (typeof reason !== 'string' || reason.trim() === '') {
                    violations.push({ ...entry, reason })
                }
            }
        }
    }
    assert.deepEqual(
        violations,
        [],
        `allowlisted classifications without reason: ${JSON.stringify(violations)}`
    )
})

test('coverage test sees at least one method per known controller', () => {
    for (const ctor of controllers) {
        const found = collectScopedMethods(ctor)
        // Some controllers (e.g. OpenAiChatCompletions) have a single method —
        // still > 0. If a controller has zero scoped methods, the test
        // should fail so we notice the controller was added without scope
        // decoration.
        assert.ok(
            found.length > 0,
            `${ctor.name} has no @RequireApiTokenScope methods; either remove from the registry above or add scope decorators`
        )
    }
})
