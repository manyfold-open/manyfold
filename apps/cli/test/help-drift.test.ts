import test from 'node:test'
import assert from 'node:assert/strict'
import {
    AGENT_HELP_TOPICS,
    renderAgentHelp,
    type AgentHelpTopic
} from '../src/agent-help/helpers'
import { agentHelpDocs } from '../src/agent-help/docs'
import { HUMAN_HELP_GROUPS } from '../src/human-help'
import { buildProgram } from '../src/program'

const TOPIC_COMMANDS: Record<AgentHelpTopic, string[]> = {
    index: [],
    auth: ['auth', 'login', 'whoami'],
    safety: [],
    channels: ['channels'],
    'channels-create': [],
    'channels-send': [],
    automations: ['automations'],
    files: ['files'],
    'model-config': ['model-config'],
    skills: ['skills'],
    connections: ['connections'],
    runtime: ['runtime', 'agent-runtimes'],
    agent: ['agent', 'agents'],
    backups: ['backups'],
    usage: ['usage'],
    a2a: ['a2a']
}

const EXCLUDED_COMMANDS = [
    'daemon',
    'profile',
    'setup',
    'update',
    'help'
] as const

const documentedCommands = new Set(Object.values(TOPIC_COMMANDS).flat())

test('every registered command has an agent-help topic or is excluded', () => {
    const program = buildProgram()
    for (const cmd of program.commands) {
        const names = [cmd.name(), ...cmd.aliases()]
        for (const name of names) {
            const covered =
                documentedCommands.has(name) ||
                (EXCLUDED_COMMANDS as readonly string[]).includes(name)
            assert.ok(
                covered,
                `command '${name}' has no agent-help topic — add it to ` +
                    `TOPIC_COMMANDS (and write a doc) or to EXCLUDED_COMMANDS`
            )
        }
    }
})

test('every topic command maps to a real registered command', () => {
    const program = buildProgram()
    const registered = new Set(
        program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()])
    )
    for (const [topic, commands] of Object.entries(TOPIC_COMMANDS)) {
        for (const name of commands) {
            assert.ok(
                registered.has(name),
                `topic '${topic}' references unregistered command '${name}'`
            )
        }
    }
})

test('human help groups cover every root command exactly once', () => {
    const registered = buildProgram().commands.map((command) => command.name())
    const grouped = HUMAN_HELP_GROUPS.flatMap((group) => [...group.commands])
    assert.deepEqual([...grouped].sort(), [...registered].sort())
    assert.equal(new Set(grouped).size, grouped.length)
})

test('excluded commands are not also documented', () => {
    for (const name of EXCLUDED_COMMANDS) {
        assert.ok(
            !documentedCommands.has(name),
            `'${name}' is both excluded and documented`
        )
    }
})

test('topic registry maps stay aligned with the topic list', () => {
    assert.deepEqual(
        Object.keys(TOPIC_COMMANDS).sort(),
        [...AGENT_HELP_TOPICS].sort()
    )
})

const SUBCOMMAND_DOC_SKIPS: Record<string, string[]> = {
    channels: ['create'],
    agent: ['model-config'],
    // Hidden deprecated aliases kept for already-provisioned agents; the doc
    // points to send/status/tasks instead.
    a2a: ['call', 'stream', 'peers']
}

test('topic docs mention every subcommand of their mapped commands', () => {
    const program = buildProgram()
    for (const [topic, commands] of Object.entries(TOPIC_COMMANDS)) {
        const rendered = renderAgentHelp(agentHelpDocs[topic as AgentHelpTopic])
        const skips = SUBCOMMAND_DOC_SKIPS[topic] ?? []
        for (const name of commands) {
            const cmd = program.commands.find((c) => c.name() === name)
            if (!cmd) continue
            for (const sub of cmd.commands) {
                if (skips.includes(sub.name())) continue
                const mentioned = [sub.name(), ...sub.aliases()].some(
                    (subName) => rendered.includes(`${name} ${subName}`)
                )
                assert.ok(
                    mentioned,
                    `doc '${topic}' does not mention '${name} ${sub.name()}' — ` +
                        `document the subcommand or add it to SUBCOMMAND_DOC_SKIPS`
                )
            }
        }
    }
})
