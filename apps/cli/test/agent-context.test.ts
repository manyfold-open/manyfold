import test from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { resolveAgentId, resolveOptionalAgentId } from '../src/agent-context'

const restoreEnv = (key: string, previous: string | undefined): void => {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
}

const withEnv = (value: string | undefined, fn: () => void): void => {
    const previous = process.env.MF_AGENT_ID
    if (value === undefined) delete process.env.MF_AGENT_ID
    else process.env.MF_AGENT_ID = value
    try {
        fn()
    } finally {
        restoreEnv('MF_AGENT_ID', previous)
    }
}

const rootProgram = (argv: string[]): Command => {
    const program = new Command()
    program
        .name('mf')
        .option('--agent-id <id>', 'agent context', process.env.MF_AGENT_ID)
    program.parse(['node', 'mf', ...argv], { from: 'node' })
    return program
}

test('resolveAgentId: subcommand-local flag wins over everything', () => {
    withEnv('agt_env', () => {
        const program = rootProgram(['--agent-id', 'agt_root'])
        assert.equal(resolveAgentId('agt_flag', program), 'agt_flag')
    })
})

test('resolveAgentId: explicit root flag wins over env', () => {
    withEnv('agt_env', () => {
        const program = rootProgram(['--agent-id', 'agt_root'])
        assert.equal(resolveAgentId(undefined, program), 'agt_root')
    })
})

test('resolveAgentId: env applies when no flag is passed', () => {
    withEnv('agt_env', () => {
        const program = rootProgram([])
        assert.equal(resolveAgentId(undefined, program), 'agt_env')
    })
})

test('resolveAgentId: trims whitespace and treats blanks as absent', () => {
    withEnv('   ', () => {
        const program = rootProgram([])
        assert.throws(
            () => resolveAgentId(undefined, program),
            /agent id is required/
        )
    })
    withEnv(undefined, () => {
        const program = rootProgram(['--agent-id', '  agt_pad  '])
        assert.equal(resolveAgentId(undefined, program), 'agt_pad')
    })
})

test('resolveAgentId: errors with guidance when nothing is set', () => {
    withEnv(undefined, () => {
        const program = rootProgram([])
        assert.throws(
            () => resolveAgentId(undefined, program),
            /agent id is required: pass --agent-id, set \$MF_AGENT_ID/
        )
    })
})

test('resolveOptionalAgentId: returns undefined when nothing is set', () => {
    withEnv(undefined, () => {
        const program = rootProgram([])
        assert.equal(resolveOptionalAgentId(undefined, program), undefined)
    })
})

// Regression for the `skills install --agent-id` bug: with Commander's
// non-positional parsing the root program consumes `--agent-id` even when
// it appears after a subcommand that declares its own `--agent-id`, so the
// subcommand's opts stay empty. The resolver must recover the value from
// the root program.
test('root consumes --agent-id placed after a subcommand; resolver recovers it', () => {
    withEnv(undefined, () => {
        const program = new Command()
        program
            .name('mf')
            .option('--agent-id <id>', 'agent context', process.env.MF_AGENT_ID)
        const skills = program.command('skills')
        let localAgentId: string | undefined = 'sentinel'
        let resolved: string | undefined
        skills
            .command('install')
            .requiredOption('--skill-id <id>')
            .option('--agent-id <id>')
            .action((opts: { agentId?: string }) => {
                localAgentId = opts.agentId
                resolved = resolveOptionalAgentId(opts.agentId, program)
            })
        program.parse(
            ['skills', 'install', '--skill-id', 'sk_x', '--agent-id', 'agt_a'],
            { from: 'user' }
        )
        assert.equal(localAgentId, undefined)
        assert.equal(resolved, 'agt_a')
    })
})
