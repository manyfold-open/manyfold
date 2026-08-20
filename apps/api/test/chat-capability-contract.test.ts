import {
    AgentFramework,
    ChatCapabilities,
    agentFramework,
    chatCapabilitiesByFramework
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatAdapterRegistry } from '../src/modules/chat/adapters/adapter-registry.service'
import { FakeEchoAdapter } from '../src/modules/chat/adapters/fake-echo.adapter'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import { NarraNexusChatAdapter } from '../src/modules/narranexus/narranexus-chat.adapter'
import {
    A2aChatAdapter,
    DifyChatAdapter,
    LangflowChatAdapter
} from '../src/modules/chat/adapters/external-api.adapter'

// A framework declares its chat capabilities twice: in the shared table every
// client reads, and in its adapter's getCapabilities(). Both were written the
// same day and hermes's two copies contradicted each other for four months
// (#677) — thinking and tool blocks the adapter streamed and the API persisted
// were dropped by the Web, because the table said hermes had neither. Nothing
// in production calls getCapabilities(), so nothing executed the second copy
// and nothing compared them. This file is that missing signal.

const ALL_FRAMEWORKS = Object.values(agentFramework) as AgentFramework[]

// No getCapabilities() implementation touches an injected dependency, so every
// dependency here is a placeholder: the registry is built to answer WHICH
// adapter a framework resolves to in production, not to run a turn through one.
const dep = {} as never

// dify, langflow and a2a share one ExternalApiChatAdapter whose
// getCapabilities() returns `chatCapabilitiesByFramework[this.framework]` — the
// table itself. Their rows below are therefore compared against themselves and
// cannot fail today, which is the end state this whole file argues for: one
// source per framework. They stay in the loop rather than being excluded from
// it because the day one of them grows its own literal is the day the
// comparison starts carrying signal, and nobody should have to remember to add
// it back.
const SELF_SOURCED: AgentFramework[] = ['dify', 'langflow', 'a2a']

const buildRegistry = (): ChatAdapterRegistry =>
    new ChatAdapterRegistry(
        new FakeEchoAdapter(),
        new ClaudeCodeAdapter(dep, dep),
        new OpenclawAdapter(dep, dep, dep, dep, dep, dep),
        new CodexAdapter(dep, dep, dep),
        new GeminiCliAdapter(dep, dep, dep),
        new HermesAdapter(dep, dep, dep, dep, dep),
        new NarraNexusChatAdapter(dep, dep, dep, dep, dep, dep),
        new DifyChatAdapter(dep, dep, dep),
        new LangflowChatAdapter(dep, dep, dep),
        new A2aChatAdapter(dep, dep, dep)
    )

test('every framework resolves to its own registered adapter', () => {
    // get() answers with the fake-echo fallback for an unregistered framework,
    // and that fallback declares itself claude-code — so without this the
    // comparison below could pass against an adapter that never serves the
    // turn.
    const registry = buildRegistry()
    for (const framework of ALL_FRAMEWORKS) {
        assert.equal(
            registry.has(framework),
            true,
            `${framework} has no registered chat adapter`
        )
        assert.equal(
            registry.get(framework).framework,
            framework,
            `${framework} resolves to an adapter declaring a different framework`
        )
    }
})

// Which rows the test below actually compares two sources for, made executable
// rather than asserted in a comment: a table lookup hands back the very object
// in the table, a literal builds a fresh one, so reference identity separates
// them. Fails when a self-sourced framework grows its own literal (the drift
// surface just widened, and the comparison below starts carrying signal) and
// when an independently-declared one stops having one (that row's comparison
// just went vacuous, and this file no longer covers it).
test('exactly the known frameworks declare capabilities by reading the shared row', () => {
    const registry = buildRegistry()
    const selfSourced = ALL_FRAMEWORKS.filter(
        (framework) =>
            registry.get(framework).getCapabilities() ===
            chatCapabilitiesByFramework[framework]
    )
    assert.deepEqual([...selfSourced].sort(), [...SELF_SOURCED].sort())
})

test('the shared capability row equals the adapter getCapabilities(), field for field', () => {
    const registry = buildRegistry()
    const drift: string[] = []
    for (const framework of ALL_FRAMEWORKS) {
        const declared = registry.get(framework).getCapabilities()
        const shared = chatCapabilitiesByFramework[framework]
        // The union of both key sets, not ChatCapabilities' keys: a field one
        // side grew and the other did not is drift the type cannot see.
        const fields = new Set([
            ...Object.keys(declared),
            ...Object.keys(shared)
        ]) as Set<keyof ChatCapabilities>
        for (const field of fields) {
            if (declared[field] === shared[field]) continue
            drift.push(
                `${framework}.${field}: adapter ${declared[field]}, shared table ${shared[field]}`
            )
        }
    }
    // Reported in one list rather than per framework: a value that moved on one
    // side usually moved for a reason, and seeing every disagreement at once is
    // what tells you which side is the mistake.
    assert.deepEqual(drift, [])
})
