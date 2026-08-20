import test from 'node:test'
import assert from 'node:assert/strict'
import {
    parseResolverOutput,
    pickLoginShell
} from '../src/daemon/login-shell-path'

const ALLOWED = ['claude', 'codex', 'gemini', 'openclaw', 'hermes']

test('parseResolverOutput keeps name<TAB>/abs/path lines', () => {
    const out =
        'claude\t/Users/me/.nvm/versions/node/v20/bin/claude\n' +
        'codex\t/opt/homebrew/bin/codex\n'
    assert.deepEqual(parseResolverOutput(out, ALLOWED), {
        claude: '/Users/me/.nvm/versions/node/v20/bin/claude',
        codex: '/opt/homebrew/bin/codex'
    })
})

test('parseResolverOutput drops rc-file noise, unknown names, and non-absolute paths', () => {
    const out = [
        'oh-my-zsh is updating...', // no tab — stray stdout from an rc file
        'gemini\t/usr/local/bin/gemini', // good
        'evilbin\t/usr/bin/evil', // name not in the allow-list
        'claude\tclaude: aliased to foo', // command -v printed an alias, not a path
        '' // blank line
    ].join('\n')
    assert.deepEqual(parseResolverOutput(out, ALLOWED), {
        gemini: '/usr/local/bin/gemini'
    })
})

test('parseResolverOutput keeps the first hit per name', () => {
    const out = 'hermes\t/a/bin/hermes\nhermes\t/b/bin/hermes\n'
    assert.deepEqual(parseResolverOutput(out, ALLOWED), {
        hermes: '/a/bin/hermes'
    })
})

test('pickLoginShell returns a supported POSIX shell from $SHELL', () => {
    const prev = process.env.SHELL
    try {
        process.env.SHELL = '/bin/zsh'
        assert.equal(pickLoginShell(), '/bin/zsh')
        process.env.SHELL = '/opt/homebrew/bin/bash'
        assert.equal(pickLoginShell(), '/opt/homebrew/bin/bash')
    } finally {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
    }
})

test('pickLoginShell rejects fish and other non-POSIX shells', () => {
    const prev = process.env.SHELL
    try {
        process.env.SHELL = '/usr/bin/fish'
        assert.equal(pickLoginShell(), null)
    } finally {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
    }
})
