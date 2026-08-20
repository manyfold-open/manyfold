import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildProgram } from '../src/program'
import { markdownInvocations, validateCommandPath } from './command-docs'

test('README shell examples reference real CLI command paths and options', () => {
    const readme = readFileSync(
        new URL('../README.md', import.meta.url),
        'utf8'
    )
    const invocations = markdownInvocations(readme)
    assert.ok(invocations.length > 0, 'README contains no mf shell examples')

    const program = buildProgram()
    for (const invocation of invocations) {
        assert.doesNotThrow(
            () => validateCommandPath(program, invocation.argv),
            `README.md:${invocation.line} has stale CLI syntax: ${invocation.source}`
        )
    }
})

test('README drift validation rejects an unregistered subcommand', () => {
    assert.throws(
        () => validateCommandPath(buildProgram(), ['agent', 'run', 'agt_xxx']),
        /unknown subcommand 'run' under 'agent'/
    )
})

test('README drift validation checks options after positional arguments', () => {
    assert.throws(
        () =>
            validateCommandPath(buildProgram(), [
                'agent',
                'get',
                'agt_xxx',
                '--stale-option'
            ]),
        /unknown option '--stale-option'/
    )
})

test('README drift validation checks required command options', () => {
    assert.throws(
        () =>
            validateCommandPath(buildProgram(), [
                'automations',
                'create',
                '--title',
                'test',
                '--prompt',
                'test',
                '--schedule-preset',
                'daily',
                '--timezone',
                'UTC'
            ]),
        /missing required option '--rrule <rrule>'/
    )
})
